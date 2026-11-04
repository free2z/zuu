/**
 * A creator's uploads can be private. The zPage editor's pickers used to list
 * every one of them and let the creator pick any of them, with the raw server
 * enum as the only hint — and then, for the body, quietly download the file
 * and re-upload a PUBLIC copy so the image rendered anyway. Nothing in the
 * flow said what was happening in either direction.
 *
 * These tests pin the replacement: show every file, mark its tier, and gate on
 * INSERT — with the promotion taking the server's re-serialized object back,
 * because the URL prefix is derived from the access level.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  allowedAccessForSlot,
  requiredAccessForSlot,
  restrictedMediaPaths,
  satisfiesSlot,
} from "../src/lib/components/media/mediaAccess.ts";
import {
  MediaAccessPromotionError,
  promoteMediaAccess,
} from "../src/lib/components/media/promoteMediaAccess.ts";

const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

const imagePickerSource = await read(
  "../src/lib/components/mdEditor/EditorImagePicker.svelte",
);
const contentFieldSource = await read(
  "../src/lib/components/mdEditor/EditorContentField.svelte",
);
// Extracted from EditorContentField by  and shared with Converse.
const textareaControllerSource = await read(
  "../src/lib/components/mdEditor/markdownTextarea.svelte.ts",
);
const inlineUploadsSource = await read(
  "../src/lib/components/mdEditor/inlineUploads.ts",
);
const converseComposerSource = await read(
  "../src/lib/components/converse/ConverseComposer.svelte",
);
const coverPanelSource = await read(
  "../src/lib/components/mdEditor/CoverLibraryPanel.svelte",
);
const composerSource = await read(
  "../src/lib/components/mdEditor/EditorComposer.svelte",
);
const editPageSource = await read("../src/routes/edit/+page.svelte");
const publishSheetSource = await read(
  "../src/lib/components/mdEditor/PublishSheet.svelte",
);
const topbarSource = await read(
  "../src/lib/components/mdEditor/EditorTopbar.svelte",
);
const badgeSource = await read(
  "../src/lib/components/media/MediaAccessBadge.svelte",
);
const uploadsApiSource = await read("../src/lib/api/uploads.ts");
const zpageSerializerSource = await read(
  "../../../../py/free2z/dj/apps/g12f/serializers/zpage.py",
);
const uploadsModelSource = await read(
  "../../../../py/free2z/dj/apps/uploads/models.py",
);

const localeNames = ["en", "es", "fr", "pt-BR"];
const localeMessages = Object.fromEntries(
  await Promise.all(
    localeNames.map(async (name) => [
      name,
      JSON.parse(await read(`../src/lib/locales/${name}.json`)),
    ]),
  ),
);

/** A stub `Response` good enough for the helper's touch points. */
function stubResponse({ ok = true, status, body = null, json } = {}) {
  return {
    ok,
    status: status ?? (ok ? 200 : 400),
    json: json ?? (async () => body),
  };
}

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

test("a cover must be public whatever tier the page is", () => {
  for (const subscriberOnly of [false, true]) {
    const context = { slot: "cover", subscriberOnly };
    assert.deepEqual(allowedAccessForSlot(context), ["public"]);
    assert.equal(satisfiesSlot("public", context), true);
    // A subscribers-only page keeps its title, description and featured_image
    // in the anonymous response — only `content` is swapped out — so the cover
    // is served to people who have not paid. `members` is not enough for it.
    assert.equal(satisfiesSlot("members", context), false);
    assert.equal(satisfiesSlot("private", context), false);
    assert.equal(requiredAccessForSlot("members", context), "public");
    assert.equal(requiredAccessForSlot("private", context), "public");
    assert.equal(requiredAccessForSlot("public", context), null);
  }
});

test("a public page's body image must be public", () => {
  const context = { slot: "body", subscriberOnly: false };
  assert.deepEqual(allowedAccessForSlot(context), ["public"]);
  assert.equal(satisfiesSlot("public", context), true);
  assert.equal(satisfiesSlot("members", context), false);
  assert.equal(requiredAccessForSlot("members", context), "public");
  assert.equal(requiredAccessForSlot("private", context), "public");
});

test("a subscribers-only page's body image may be members-tier", () => {
  const context = { slot: "body", subscriberOnly: true };
  // The old React picker hardcoded `access=public` on this query, which hid a
  // legitimate choice: the body is already redacted for non-subscribers, so a
  // members image in it is the paid-content model working.
  assert.equal(satisfiesSlot("members", context), true);
  assert.equal(satisfiesSlot("public", context), true);
  assert.equal(satisfiesSlot("private", context), false);
  //...and least privilege on the way up: promoting a private file to PUBLIC
  // here would publish, to the open internet, the thing being charged for.
  assert.equal(requiredAccessForSlot("private", context), "members");
  assert.notEqual(requiredAccessForSlot("private", context), "public");
});

test("an unreadable access value is treated as private, never as shareable", () => {
  for (const context of [
    { slot: "body", subscriberOnly: false },
    { slot: "body", subscriberOnly: true },
    { slot: "cover" },
  ]) {
    for (const junk of [
      undefined,
      null,
      "",
      "PUBLIC",
      "everyone",
      "members ",
    ]) {
      assert.equal(
        satisfiesSlot(junk, context),
        false,
        `${JSON.stringify(junk)} must not satisfy ${JSON.stringify(context)}`,
      );
    }
  }
});

test("the backend still says what these rules are derived from", () => {
  // Body: `content` and only `content` is replaced for a non-subscriber.
  assert.match(zpageSerializerSource, /_redact_content/);
  assert.match(
    zpageSerializerSource,
    /["']content["']:\s*\(\s*["']Subscribe for exclusive content["']/,
  );
  // Cover: featured_image is a plain serialized field, untouched by that.
  assert.match(
    zpageSerializerSource,
    /featured_image = FeaturedImageSerializer\(\)/,
  );
  // And the URL prefix really is derived from the access level.
  assert.match(uploadsModelSource, /def _get_prefix\(self\)/);
  assert.match(uploadsModelSource, /return ["']\/uploadz\/public\/["']/);
  assert.match(uploadsModelSource, /return ["']\/uploadz\/["']/);
});

// ---------------------------------------------------------------------------
// The trap: a promotion changes the URL
// ---------------------------------------------------------------------------

test("a promotion returns the SERVER's object, so the new URL prefix is used", async () => {
  // `_get_prefix()` sends `public` to /uploadz/public/ and everything else to
  // /uploadz/. Every URL-bearing field moves at once, so a caller that keeps
  // the object it already had inserts the pre-promotion prefix for the
  // post-promotion tier — exactly the broken image the gate exists to prevent.
  const stale = {
    id: 42,
    access: "private",
    url: "/uploadz/cat.png",
    thumbnail: "/uploadz/cat.webp",
    thumb: "/uploadz/cat-256.webp",
    card: "/uploadz/cat-640.webp",
    banner: "/uploadz/cat-1280.webp",
    variants: [{ width: 256, url: "/uploadz/cat-256.webp" }],
    mime_type: "image/png",
  };
  const fresh = {
    id: 42,
    access: "public",
    url: "/uploadz/public/cat.png",
    thumbnail: "/uploadz/public/cat.webp",
    thumb: "/uploadz/public/cat-256.webp",
    card: "/uploadz/public/cat-640.webp",
    banner: "/uploadz/public/cat-1280.webp",
    variants: [{ width: 256, url: "/uploadz/public/cat-256.webp" }],
    mime_type: "image/png",
  };

  const result = await promoteMediaAccess({
    item: stale,
    access: "public",
    request: async () => stubResponse({ body: fresh }),
  });

  assert.deepEqual(result, fresh);
  // Spelled out one field at a time: a `{...item,...updated}` implementation
  // passes the deepEqual above only by accident of key overlap, and would
  // still leak any field the serializer happened to omit.
  for (const field of [
    "url",
    "thumbnail",
    "thumb",
    "card",
    "banner",
    "access",
  ]) {
    assert.equal(
      result[field],
      fresh[field],
      `${field} must come from the server`,
    );
    assert.notEqual(
      result[field],
      stale[field],
      `${field} must not be the stale value`,
    );
  }
  assert.deepEqual(result.variants, fresh.variants);
  assert.equal(result.url.startsWith("/uploadz/public/"), true);
});

test("a promotion PATCHes only the access field, at the right URL", async () => {
  const calls = [];
  await promoteMediaAccess({
    item: { id: 7, title: "kept", description: "kept" },
    access: "members",
    apiBase: "https://free2z.cash",
    request: async (input, init) => {
      calls.push({ input, init });
      return stubResponse({ body: { id: 7, url: "/uploadz/x.png" } });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "https://free2z.cash/api/myuploads/7/");
  assert.equal(calls[0].init.method, "PATCH");
  // Replaying title/description would turn a visibility change into a
  // last-write-wins overwrite of fields this dialog never showed anyone.
  assert.deepEqual(JSON.parse(calls[0].init.body), { access: "members" });
});

test("a stale picker cannot DOWNGRADE a file that is already open enough", async () => {
  // The picker's list is a snapshot. If another tab made this file public and
  // published `/uploadz/public/...` links against it, PATCHing it to the least
  // open tier that satisfies a subscribers-only page would break all of them.
  const fresh = { id: 11, access: "public", url: "/uploadz/public/a.png" };
  const calls = [];

  const result = await promoteMediaAccess({
    item: { id: 11, access: "private", url: "/uploadz/a.png" },
    access: "members",
    request: async (input, init) => {
      calls.push(init.method);
      return stubResponse({ body: fresh });
    },
    satisfies: (candidate) => candidate.access !== "private",
  });

  assert.deepEqual(calls, ["GET"], "no write may be issued");
  //...and the caller still gets the CURRENT object, not the stale one.
  assert.deepEqual(result, fresh);
});

test("the re-read gates the write, and a write is never a demotion", async () => {
  // The fresh object still does not satisfy: GET, then PATCH.
  const calls = [];
  await promoteMediaAccess({
    item: { id: 12, access: "private", url: "/uploadz/b.png" },
    access: "public",
    request: async (input, init) => {
      calls.push(init.method);
      return stubResponse({
        body: { id: 12, access: "private", url: "/uploadz/b.png" },
      });
    },
    satisfies: (candidate) => candidate.access === "public",
  });
  assert.deepEqual(calls, ["GET", "PATCH"]);

  // A re-read that FAILS must not fall through to the write. This is an
  // absolute tier assignment on an object other pages may already reference:
  // without knowing the current tier, "promote" could be a demotion that 401s
  // every /uploadz/public/... link already published against the file.
  const afterFailedRead = [];
  await assert.rejects(
    promoteMediaAccess({
      item: { id: 13, access: "private", url: "/uploadz/c.png" },
      access: "public",
      request: async (input, init) => {
        afterFailedRead.push(init.method);
        if (init.method === "GET") throw new TypeError("offline");
        return stubResponse({ body: { id: 13, url: "/uploadz/public/c.png" } });
      },
      satisfies: () => false,
    }),
    (error) =>
      error instanceof MediaAccessPromotionError &&
      // Nothing was written, so it is a clean failure and a retry is safe.
      error.indeterminate === false,
  );
  assert.deepEqual(
    afterFailedRead,
    ["GET"],
    "no write may follow a failed read",
  );

  // And even a SUCCESSFUL read cannot produce a demoting write: the caller
  // asks for the least-open tier that satisfies its slot, which is the wrong
  // request to make of a file that turned out to be more open than that.
  const noDowngrade = [];
  const kept = await promoteMediaAccess({
    item: { id: 17, access: "private", url: "/uploadz/g.png" },
    access: "members",
    request: async (input, init) => {
      noDowngrade.push(init.method);
      return stubResponse({
        body: { id: 17, access: "public", url: "/uploadz/public/g.png" },
      });
    },
    // Deliberately says "no" about a public file, which is what a caller with
    // a broken rule would do. The rank check is the backstop.
    satisfies: () => false,
  });
  assert.deepEqual(noDowngrade, ["GET"]);
  assert.equal(kept.access, "public");
});

test("a write that may have landed is reported as indeterminate, not as a failure", async () => {
  // "Could not change it" on a write that DID commit leaves the creator
  // believing a file is private while it is anonymously fetchable.
  const dropped = await promoteMediaAccess({
    item: { id: 14, url: "/uploadz/d.png" },
    access: "public",
    request: async () => {
      throw new TypeError("network error");
    },
  }).catch((error) => error);
  assert.ok(dropped instanceof MediaAccessPromotionError);
  assert.equal(dropped.indeterminate, true);

  // 2xx with a body we cannot read: same class of unknown.
  const unreadable = await promoteMediaAccess({
    item: { id: 15, url: "/uploadz/e.png" },
    access: "public",
    request: async () => stubResponse({ body: null }),
  }).catch((error) => error);
  assert.equal(unreadable.indeterminate, true);

  // A 4xx is Django ANSWERING: it looked at the request and refused it, so
  // nothing was committed and calling it indeterminate would send the creator
  // hunting for a change that is not there.
  const refused = await promoteMediaAccess({
    item: { id: 16, url: "/uploadz/f.png" },
    access: "public",
    request: async () =>
      stubResponse({ ok: false, status: 400, body: { detail: "Nope." } }),
  }).catch((error) => error);
  assert.equal(refused.indeterminate, false);
  assert.equal(refused.message, "Nope.");

  // A 5xx is not an answer. A worker restart or a proxy timeout AFTER the
  // transaction committed arrives as an ordinary 502/504 that `fetch`
  // RESOLVES, so it belongs with the unknowns, not with the refusals.
  for (const status of [500, 502, 503, 504]) {
    const upstream = await promoteMediaAccess({
      item: { id: 18, url: "/uploadz/h.png" },
      access: "public",
      request: async () => stubResponse({ ok: false, status, body: null }),
    }).catch((error) => error);
    assert.equal(
      upstream.indeterminate,
      true,
      `a ${status} must not be reported as a clean failure`,
    );
  }
});

test("the picker re-reads the library when a promotion's outcome is unknown", () => {
  const confirm = imagePickerSource.match(
    /async function confirmPromotion\(\)[\s\S]*?\n  \}/,
  )?.[0];
  assert.ok(confirm, "could not find confirmPromotion");

  assert.match(
    confirm,
    /satisfies:[\s\S]{0,200}satisfiesSlot\(\s*candidate\.access\s*,\s*slotContext\s*\)/,
  );
  assert.match(confirm, /if \(error\?\.indeterminate\)/);
  assert.match(confirm, /void loadCloud\(true\)/);
  assert.match(confirm, /editor\.imageAccessChangeUnknown/);
});

test("a refused or unreadable promotion throws instead of returning the stale file", async () => {
  const stale = { id: 3, url: "/uploadz/x.png", access: "private" };

  await assert.rejects(
    promoteMediaAccess({
      item: stale,
      access: "public",
      request: async () =>
        stubResponse({ ok: false, body: { access: ["Not a valid choice."] } }),
    }),
    (error) =>
      error instanceof MediaAccessPromotionError &&
      error.message === "Not a valid choice.",
  );

  // 2xx, but no representation to read the new prefix out of. The write may
  // well have landed; guessing the URL is how a "fixed" image ships broken.
  for (const body of [null, {}, { id: 3 }, { url: "/uploadz/public/x.png" }]) {
    await assert.rejects(
      promoteMediaAccess({
        item: stale,
        access: "public",
        request: async () => stubResponse({ body }),
      }),
      MediaAccessPromotionError,
      `a ${JSON.stringify(body)} response must not be accepted`,
    );
  }

  await assert.rejects(
    promoteMediaAccess({
      item: stale,
      access: "public",
      request: async () =>
        stubResponse({
          json: async () => {
            throw new SyntaxError("not json");
          },
        }),
    }),
    MediaAccessPromotionError,
  );
});

// ---------------------------------------------------------------------------
// The pickers
// ---------------------------------------------------------------------------

test("the body picker shows every upload and gates on insert, not on the query", () => {
  // Filtering the query is what the old React FileSelectorDialog did
  // (`access=public`), and it hides the members image a subscribers-only page
  // is entitled to use.
  const query = imagePickerSource.match(
    /const params = new URLSearchParams\(\{[\s\S]*?\}\);/,
  )?.[0];
  assert.ok(query, "could not find the cloud query");
  assert.doesNotMatch(query, /access/);

  // Every row carries its tier.
  assert.match(
    imagePickerSource,
    /<MediaAccessBadge\s+access=\{item\.access\}/,
  );

  // The decision is made against the file as the SERVER has it, not against
  // the list's snapshot: a file demoted in another tab since it was listed
  // keeps the same URL, so nothing about the markdown would look wrong while
  // every reader got a 401.
  const choose = imagePickerSource.match(
    /async function chooseCloudImage\([\s\S]*?\n  \}/,
  )?.[0];
  assert.ok(choose, "could not find chooseCloudImage");
  assert.match(choose, /await readCurrentUpload<CoverLibraryImage>\(/);
  //...and a read that FAILS refuses the click rather than falling back to the
  // snapshot: falling back defeats the gate in exactly the conditions it is
  // for, and on a subscribers-only page the publish-sheet hint stays quiet too.
  assert.match(
    choose,
    /if \(\s*!current[\s\S]{0,500}editor\.imageAccessCheckFailed/,
  );
  assert.doesNotMatch(choose, /\?\? item/);
  //...and a check the creator walked away from inserts nothing. Without the
  // generation guard a stalled GET lands an image in an article they closed —
  // or, if they switched translations while waiting, in a different one.
  assert.match(choose, /const chooseId = \+\+chooseRequestId;/);
  assert.match(
    choose,
    /if \(chooseId !== chooseRequestId \|\| !open\) return;/,
  );
  assert.match(
    imagePickerSource,
    /function closePicker\(\)[\s\S]{0,200}chooseRequestId \+= 1;/,
  );
  // The decision comes from the shared rule, with the page's tier in it.
  assert.match(
    choose,
    /requiredAccessForSlot\(\s*current\.access\s*,\s*slotContext\s*\)/,
  );
  //...and that context is the body slot with the page's tier, unless the
  // host says otherwise (Converse passes `post`).
  assert.match(
    imagePickerSource,
    /const slotContext = \$derived<MediaSlotContext>\(\{\s*slot:\s*accessSlot,\s*subscriberOnly,\s*\}\)/,
  );
  assert.match(imagePickerSource, /accessSlot = ["']body["'],/);
  // Satisfied files go straight in; the rest raise the gate rather than being
  // refused outright or inserted anyway.
  assert.match(
    choose,
    /if \(!needed\) \{\s*return insertCloudItem\(current\);/,
  );
  assert.match(imagePickerSource, /pendingItem = current;/);
  assert.match(imagePickerSource, /data-media-access-gate=\{pendingAccess\}/);
  assert.match(
    imagePickerSource,
    /data-media-access-gate-action="cancel"[\s\S]{0,200}onclick=\{cancelPromotion\}/,
  );
});

test("the body picker inserts the promoted object, never the one it already had", () => {
  const confirm = imagePickerSource.match(
    /async function confirmPromotion\(\)[\s\S]*?\n  \}/,
  )?.[0];
  assert.ok(confirm, "could not find confirmPromotion");

  // The helper is the only thing that produces the object...
  assert.match(confirm, /const updated = await promoteMediaAccess\(/);
  //...and it is `updated`, not `item`, that is inserted and put back in the
  // list. This is the assertion that catches the stale-URL bug in the wiring;
  // `promoteMediaAccess` itself is pinned by the unit tests above.
  assert.match(confirm, /await insertCloudItem\(updated\)/);
  assert.doesNotMatch(confirm, /insertCloudItem\(item\)/);
  assert.match(confirm, /entry\.id === updated\.id \? updated : entry/);
  // `item` is used only to identify what to promote.
  assert.match(confirm, /item,\s*\n\s*access,/);
});

test("the cover panel labels the tier instead of printing the raw enum", () => {
  // `{item.access || $t("editor.privateAccess", "Private")}` — the server's
  // own string, untranslated, as the only warning anyone got.
  assert.doesNotMatch(coverPanelSource, /\{item\.access \|\|/);
  assert.doesNotMatch(coverPanelSource, /editor\.privateAccess/);
  assert.match(coverPanelSource, /<MediaAccessBadge\s+access=\{item\.access\}/);

  // A non-public source is confirmed, because the cover flow uploads a PUBLIC
  // copy of it — the image is not broken, the creator is just publishing a
  // file they marked private without being told.
  // The cover panel asks the server too. Trusting its snapshot here does not
  // break an image — the cover flow uploads a public COPY — it publishes a
  // file the creator has since made private, without the dialog.
  assert.match(
    coverPanelSource,
    /await readCurrentUpload<CoverLibraryImage>\(/,
  );
  assert.match(
    coverPanelSource,
    /if \(\s*!current[\s\S]{0,500}editor\.imageAccessCheckFailed/,
  );
  assert.match(
    coverPanelSource,
    /satisfiesSlot\(\s*current\.access\s*,\s*\{\s*slot:\s*["']cover["']\s*,?\s*\}\s*\)/,
  );
  assert.match(
    coverPanelSource,
    /onclick=\{\(\) => void requestChoose\(item\)\}/,
  );
  assert.match(coverPanelSource, /data-media-access-gate="cover"/);
  assert.match(
    coverPanelSource,
    /data-media-access-gate-action="promote"[\s\S]{0,200}onclick=\{confirmChoose\}/,
  );
});

test("the body insert no longer publishes a silent public copy of a private file", () => {
  const insert = textareaControllerSource.match(
    /insertCloudImage = async \([\s\S]*?\n  \};/,
  )?.[0];
  assert.ok(insert, "could not find insertCloudImage");

  // It used to fetch the blob and re-upload it: the image rendered, so nobody
  // noticed that a private file had just been published, that storage was
  // duplicated on every insert, and that a subscribers-only page's paid images
  // became anonymously fetchable.
  assert.doesNotMatch(insert, /startInlineUploads/);
  assert.doesNotMatch(insert, /new File\(/);
  assert.doesNotMatch(insert, /response\.blob\(\)/);

  // It inserts the file's own URL, and refuses anything the readers of this
  // page could not open — a second line of defence behind the picker's gate.
  assert.match(insert, /buildImageMarkdown\(title, item\.url, t\)/);
  assert.match(
    insert,
    /const slot = this\.#options\.mediaSlot\(\);\s*if \(!slot \|\| !satisfiesSlot\(item\.access, slot\)\)/,
  );
  // The zPage body hands the controller the body slot with the page's tier.
  assert.match(
    contentFieldSource,
    /mediaSlot:\s*\(\)\s*=>\s*\(\{\s*slot:\s*["']body["'],\s*subscriberOnly\s*\}\)/,
  );
  // The picker callbacks are the controller's, not a local copy.
  assert.match(
    contentFieldSource,
    /onChooseCloudImage=\{editor\.insertCloudImage\}/,
  );
  assert.match(insert, /editor\.imageAccessUnreachable/);
});

test("the page's subscriber tier reaches the picker from the editor state", () => {
  assert.match(editPageSource, /subscriberOnly=\{isSubscriberOnly\}/);
  assert.match(composerSource, /subscriberOnly = false,/);
  assert.match(
    composerSource,
    /<EditorContentField[\s\S]{0,400}\{subscriberOnly\}/,
  );
  assert.match(
    contentFieldSource,
    /<EditorImagePicker[\s\S]{0,300}\{subscriberOnly\}/,
  );
  // The cover deliberately does NOT take it: its rule does not depend on the
  // page tier, and threading it there would invite someone to relax it.
  assert.doesNotMatch(
    composerSource,
    /<EditorCoverField[\s\S]{0,300}subscriberOnly/,
  );
});

test("a fresh editor upload lands public, in both slots", () => {
  // Cover crop, inline paste and drag-to-upload all go through this one call.
  assert.match(
    uploadsApiSource,
    /formData\.append\(["']access["'],\s*["']public["']\)/,
  );
  assert.match(
    inlineUploadsSource,
    /const uploaded = await uploadPublicFile\(/,
  );
  //...and the pipeline is handed the one public uploader, not some other.
  assert.match(
    textareaControllerSource,
    /import \{ isUploadRejection, uploadPublicFile \} from "\$lib\/api\/uploads"/,
  );
});

// ---------------------------------------------------------------------------
// Turning "Subscribers Only" back off (codex review of this PR)
// ---------------------------------------------------------------------------

test("a body image a logged-out reader cannot fetch is found from the markdown alone", () => {
  // `_get_prefix()` is the whole detector: public files live under
  // /uploadz/public/, every other tier under /uploadz/. No request needed —
  // and a public path starts with the restricted one, so the ordering of the
  // two tests matters.
  const markdown = [
    "![Public](/uploadz/public/ok.png)",
    "![Members](/uploadz/paid.png)",
    '<img src="/uploadz/also-paid.webp">',
    "![Again](/uploadz/paid.png)",
    "[a link](https://example.com/uploadz/elsewhere.png)",
  ].join("\n\n");

  assert.deepEqual(restrictedMediaPaths(markdown), [
    "/uploadz/paid.png",
    "/uploadz/also-paid.webp",
  ]);
  // Nothing to say about a page whose images are all public.
  assert.deepEqual(
    restrictedMediaPaths("![Public](/uploadz/public/ok.png)"),
    [],
  );
  assert.deepEqual(restrictedMediaPaths(""), []);
});

test("the editor warns when a non-public image sits in a page that is not subscribers-only", () => {
  // The rule is evaluated at INSERT time against a tier the creator can move
  // afterwards. Turning the switch off makes a legitimately-inserted `members`
  // image a 401 for every reader — silently, because the owner's own preview
  // still works.
  assert.match(
    publishSheetSource,
    /restrictedBodyMedia = \$derived\(restrictedMediaPaths\(content\)\)/,
  );
  assert.match(
    publishSheetSource,
    /\{#if !isSubscriberOnly && restrictedBodyMedia\.length > 0\}/,
  );
  assert.match(
    publishSheetSource,
    /data-restricted-body-media=\{restrictedBodyMedia\.length\}/,
  );
  assert.match(publishSheetSource, /editor\.restrictedBodyMediaOne/);
  assert.match(publishSheetSource, /editor\.restrictedBodyMediaMany/);
  // The body has to reach the sheet for any of that to run.
  assert.match(topbarSource, /<PublishSheet[\s\S]{0,400}\{content\}/);

  // A warning, never a block: nothing about it may gate the save buttons.
  const footer = publishSheetSource.match(
    /<Sheet\.Footer[\s\S]*?<\/Sheet\.Footer>/,
  )?.[0];
  assert.ok(footer, "could not find the sheet footer");
  assert.doesNotMatch(footer, /restrictedBodyMedia/);
});

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

test("the badge and both gates are translated in every locale", () => {
  const editorKeys = [
    "imageAccessTitle",
    "imageAccessMakePublicBody",
    "imageAccessMakeMembersBody",
    "imageAccessMakePublic",
    "imageAccessMakeMembers",
    "imageAccessCurrent",
    "imageAccessChangeFailed",
    "imageAccessChangeUnknown",
    "imageAccessCheckFailed",
    "imageAccessUnreachable",
    "coverAccessTitle",
    "coverAccessBody",
    "coverAccessConfirm",
    "restrictedBodyMediaOne",
    "restrictedBodyMediaMany",
  ];

  for (const name of localeNames) {
    for (const key of editorKeys) {
      const value = localeMessages[name].editor[key];
      assert.equal(
        typeof value,
        "string",
        `${name}.json is missing editor.${key}`,
      );
      assert.notEqual(value.trim(), "", `${name}.json editor.${key} is empty`);
    }
    // The badge reuses the tier names the dashboard and uploader already use,
    // so a tier is called the same thing on every media surface.
    for (const key of ["accessPublic", "accessMembers", "accessPrivate"]) {
      assert.equal(typeof localeMessages[name].media[key], "string");
    }
  }

  // Both name-bearing bodies interpolate, and `{name}` is the placeholder the
  // components pass.
  for (const name of localeNames) {
    assert.match(
      localeMessages[name].editor.restrictedBodyMediaMany,
      /\{count\}/,
      `${name}.json editor.restrictedBodyMediaMany lost its {count} placeholder`,
    );
    for (const key of [
      "imageAccessMakePublicBody",
      "imageAccessMakeMembersBody",
      "coverAccessBody",
    ]) {
      assert.match(
        localeMessages[name].editor[key],
        /\{name\}/,
        `${name}.json editor.${key} lost its {name} placeholder`,
      );
    }
  }

  assert.match(badgeSource, /media\.accessPublic/);
  assert.match(badgeSource, /media\.accessMembers/);
  assert.match(badgeSource, /media\.accessPrivate/);
  assert.match(badgeSource, /normalizeMediaAccess\(access\)/);
});

// ---------------------------------------------------------------------------
// Converse posts are public
// ---------------------------------------------------------------------------

test("a Converse post takes public images only, whatever else is passed", () => {
  // A post has no subscriber tier: the stream, the thread page and the RSS
  // feed serve it to everyone. So `post` is public-only — including when a
  // caller passes `subscriberOnly: true` by mistake, which must NOT widen it
  // the way it widens a zPage body.
  for (const subscriberOnly of [undefined, false, true]) {
    const context = { slot: "post", subscriberOnly };
    assert.deepEqual(allowedAccessForSlot(context), ["public"]);
    assert.equal(satisfiesSlot("public", context), true);
    assert.equal(satisfiesSlot("members", context), false);
    assert.equal(satisfiesSlot("private", context), false);
    assert.equal(satisfiesSlot("something-new", context), false);
    // Least privilege still lands on public: nothing less is readable.
    assert.equal(requiredAccessForSlot("private", context), "public");
    assert.equal(requiredAccessForSlot("members", context), "public");
  }
});

test("the Converse composer wires thread access into BOTH media gates", async () => {
  // The picker's pre-insert gate — and no picker at all for private or
  // unknown threads...
  assert.match(
    converseComposerSource,
    /\{#if mediaSlot\}[\s\S]{0,300}<EditorImagePicker[\s\S]{0,300}accessSlot=\{mediaSlot\.slot\}[\s\S]{0,150}subscriberOnly=\{mediaSlot\.subscriberOnly\}/,
  );
  assert.match(
    converseComposerSource,
    /beforeMediaInsert:\s*refreshThreadMediaAccess/,
    "reply media policy must be refreshed at each insertion boundary",
  );
  assert.match(
    converseComposerSource,
    /timeoutMs:\s*THREAD_MEDIA_ACCESS_TIMEOUT_MS/,
    "thread access reads must have an explicit deadline",
  );
  assert.match(
    converseComposerSource,
    /onDestroy\(\(\) => \{[\s\S]{0,160}threadAccessCheckController\?\.abort\(\)/,
    "closing the composer must cancel its current access read",
  );
  assert.match(
    converseComposerSource,
    /localUploadsAllowed=\{[\s\S]{0,160}mediaSlot\.localUploadsAllowed !== false/,
    "the picker must hide local uploads on members replies",
  );
  //...and the controller's insert-time guard behind it.
  assert.match(converseComposerSource, /mediaSlot:\s*\(\)\s*=>\s*mediaSlot,/);
  // Roots use the public-only `post` slot. Public and members zPage threads
  // use the body slot with the matching tier; private and unknown threads get
  // NO slot, so images are off. Checked literally because defaulting to
  // `post` is exactly the unsafe behavior this field prevents.
  assert.match(
    converseComposerSource,
    /const hasParentContentUrl = \$derived\([\s\S]{0,180}parentContentUrl\.trim\(\)\.length > 0/,
    "undefined and empty attachment URLs must not enable reply media",
  );
  assert.match(
    converseComposerSource,
    /const mediaSlot = \$derived<ConverseMediaSlot \| null>\([\s\S]{0,500}parentContentUrl === null && currentThreadAccess === "public"[\s\S]{0,350}hasParentContentUrl && currentThreadAccess === "members"[\s\S]{0,350}localUploadsAllowed: false[\s\S]{0,250}: null,/,
  );
  assert.match(
    converseComposerSource,
    /parentContentUrl = undefined,/,
    "an unpassed thread root must be unknown, never standalone",
  );
  assert.match(
    converseComposerSource,
    /threadAccess = undefined,/,
    "an unpassed access tier must fail closed",
  );
  const postSource = await read(
    "../src/lib/components/converse/ConversePost.svelte",
  );
  assert.match(postSource, /parentContentUrl=\{post\.content_url\}/);
  assert.match(postSource, /threadAccess=\{post\.thread_access\}/);
  assert.match(
    postSource,
    /threadAccessOwnerId=\{post\.thread_access_owner_id\}/,
  );
  // Inserting by reference, never by re-uploading a copy.
  assert.match(
    converseComposerSource,
    /onChooseCloudImage=\{editor\.insertCloudImage\}/,
  );
});

test("local image insertion refreshes its media policy before uploading", async () => {
  // `null` = "cannot tell who will see this", which must mean NO upload: a
  // file is public the moment it lands.
  assert.match(
    textareaControllerSource,
    /pendingMediaChecks = \$state\(0\)/,
    "the preflight must become visible synchronously to the submit guard",
  );
  assert.match(
    textareaControllerSource,
    /async #runMediaPreflight\(\)[\s\S]{0,500}pendingMediaChecks \+= 1[\s\S]{0,500}pendingMediaChecks -= 1/,
    "pending checks must be released after success or failure",
  );
  assert.match(
    textareaControllerSource,
    /async #prepareLocalUpload\(\)[\s\S]{0,500}#runMediaPreflight\(\)[\s\S]{0,500}this\.localUploadsAllowed/,
    "the preflight must refresh first, then fail closed on the live slot",
  );
  for (const handler of ["handlePaste = ", "handleDrop = "]) {
    const start = textareaControllerSource.indexOf(handler);
    assert.notEqual(start, -1, handler);
    const body = textareaControllerSource.slice(start, start + 1700);
    const preflight = body.indexOf("#prepareLocalUpload()");
    const upload = body.indexOf("startInlineUploads(");
    assert.notEqual(preflight, -1, `${handler} must run a fresh preflight`);
    assert.ok(preflight < upload, `${handler} must preflight BEFORE uploading`);
  }
  assert.match(
    textareaControllerSource,
    /insertLocalImages = async[\s\S]{0,350}await this\.#prepareLocalUpload\(\)[\s\S]{0,300}startInlineUploads\(/,
    "picker uploads must use the same refreshed policy",
  );
  assert.match(
    textareaControllerSource,
    /get localUploadsAllowed\(\) \{\s*const slot = this\.#options\.mediaSlot\(\);\s*return slot !== null && slot\.localUploadsAllowed !== false;/,
  );
  assert.match(
    converseComposerSource,
    /membersMediaOwnerMatches[\s\S]{0,250}currentThreadAccessOwnerId[\s\S]{0,250}\$currentUser\?\.id === currentThreadAccessOwnerId/,
    "members media must use the page owner, not the commenter, as audience",
  );
});

test("the server reports a safe media tier for every comment thread", async () => {
  // `thread_access` is the authoritative field for reply media. It must be
  // derived from the same parent and visibility rules as comment reads, so a
  // private thread cannot arrive looking public.
  const serializer = await read(
    "../../../../py/free2z/dj/apps/comments/serializers.py",
  );
  const paths = await read("../../../../py/free2z/dj/apps/g12f/zpage_paths.py");
  const visibility = await read(
    "../../../../py/free2z/dj/apps/comments/visibility.py",
  );
  const views = await read("../../../../py/free2z/dj/apps/comments/views.py");
  const conversation = await read(
    "../../../../py/free2z/dj/apps/openai/models.py",
  );
  const zpageModel = await read(
    "../../../../py/free2z/dj/apps/g12f/models/zpage.py",
  );

  // content_url remains the navigation URL, while thread_access is the media
  // policy...
  assert.match(
    serializer,
    /def get_content_url\(self, obj\):[\s\S]{0,200}content_object = obj\.content_object\s+if not content_object:\s+return None\s+return negotiated_content_url\(/,
  );
  //...and both attachable types always yield a URL...
  assert.match(paths, /method = getattr\(content_object, method_name, None\)/);
  assert.match(
    conversation,
    /def get_url\(self\):[\s\S]{0,1200}return f"\/ai\/conversation\/\{self\.id\}"/,
  );
  assert.match(zpageModel, /def get_url\(self\):\s+return f"/);
  //...a comment whose attached object is gone is never served...
  assert.match(
    visibility,
    /parent = comment\.content_object\s+if parent is None:\s+return False/,
  );
  assert.match(
    visibility,
    /def comment_thread_access\(comment\):[\s\S]{0,700}return "private"/,
  );
  assert.match(
    serializer,
    /thread_access = serializers\.SerializerMethodField\(\)/,
  );
  assert.match(
    serializer,
    /thread_access_owner_id = serializers\.SerializerMethodField\(\)/,
  );
  assert.match(
    visibility,
    /def comment_thread_access_owner_id\(comment\):[\s\S]{0,700}return parent\.creator_id/,
  );
  //...and a reply inherits its parent's attachment.
  assert.match(
    views,
    /validated_data\['content_type'\] = parent_comment\.content_type\s+serializer\.validated_data\['object_id'\] = parent_comment\.object_id/,
  );
});
