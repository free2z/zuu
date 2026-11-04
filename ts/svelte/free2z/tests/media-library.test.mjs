import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { appendMediaPage } from "../src/lib/components/mdEditor/mediaLibrary.js";
import { createDropZone } from "../src/lib/components/media/dropZone.js";
import {
  absoluteMediaUrl,
  isAllowedMediaUrl,
  isPreviewableMedia,
  resolveMediaUrl,
} from "../src/lib/components/media/mediaUrl.js";
import {
  DEFAULT_UPLOAD_ACCESS,
  MEDIA_ACCESS_LEVELS,
  isShareableAccess,
  normalizeMediaAccess,
} from "../src/lib/components/media/mediaAccess.ts";

const imagePickerSource = await readFile(
  new URL(
    "../src/lib/components/mdEditor/EditorImagePicker.svelte",
    import.meta.url,
  ),
  "utf8",
);
const coverPickerSource = await readFile(
  new URL(
    "../src/lib/components/mdEditor/CoverLibraryPanel.svelte",
    import.meta.url,
  ),
  "utf8",
);
const coverFieldSource = await readFile(
  new URL(
    "../src/lib/components/mdEditor/EditorCoverField.svelte",
    import.meta.url,
  ),
  "utf8",
);
const coverAIPanelSource = await readFile(
  new URL(
    "../src/lib/components/mdEditor/CoverAIPanel.svelte",
    import.meta.url,
  ),
  "utf8",
);
const mediaDashboardSource = await readFile(
  new URL(
    "../src/routes/[username]/dashboard/media/+page.svelte",
    import.meta.url,
  ),
  "utf8",
);
const mediaUploaderSource = await readFile(
  new URL("../src/lib/components/media/MediaUploader.svelte", import.meta.url),
  "utf8",
);
const mediaPreviewSource = await readFile(
  new URL(
    "../src/lib/components/media/MediaPreviewDialog.svelte",
    import.meta.url,
  ),
  "utf8",
);
const dropZoneSource = await readFile(
  new URL("../src/lib/components/media/dropZone.js", import.meta.url),
  "utf8",
);
const clipboardSource = await readFile(
  new URL("../src/lib/components/media/clipboard.js", import.meta.url),
  "utf8",
);
const uploadsViewSource = await readFile(
  new URL("../../../../py/free2z/dj/apps/uploads/views.py", import.meta.url),
  "utf8",
);
const uploadsModelSource = await readFile(
  new URL("../../../../py/free2z/dj/apps/uploads/models.py", import.meta.url),
  "utf8",
);
const localeNames = ["en", "es", "fr", "pt-BR"];
const localeMessages = Object.fromEntries(
  await Promise.all(
    localeNames.map(async (name) => [
      name,
      JSON.parse(
        await readFile(
          new URL(`../src/lib/locales/${name}.json`, import.meta.url),
          "utf8",
        ),
      ),
    ]),
  ),
);

test("appends media pages without replacing existing items", () => {
  const firstItem = { id: 1, title: "First" };
  const currentItems = [firstItem, { id: 2, title: "Second" }];

  const result = appendMediaPage(currentItems, [
    { id: 3, title: "Third" },
    { id: 4, title: "Fourth" },
  ]);

  assert.deepEqual(
    result.map((item) => item.id),
    [1, 2, 3, 4],
  );
  assert.equal(result[0], firstItem);
  assert.deepEqual(
    currentItems.map((item) => item.id),
    [1, 2],
  );
});

test("de-duplicates media when upload history shifts between pages", () => {
  const existingItem = { id: 12, title: "Existing version" };

  const result = appendMediaPage(
    [existingItem],
    [
      { id: 12, title: "Repeated version" },
      { id: 13, title: "New item" },
      { id: 13, title: "Repeated new item" },
    ],
  );

  assert.deepEqual(
    result.map((item) => item.id),
    [12, 13],
  );
  assert.equal(result[0], existingItem);
  assert.equal(result[1].title, "New item");
});

test("image-library dialogs are viewport bounded with independent result scrolling", () => {
  for (const dialogSource of [imagePickerSource, coverFieldSource]) {
    assert.match(dialogSource, /h-\[calc\(100dvh-2rem\)\]/);
    assert.match(dialogSource, /flex-1 gap-4 overflow-hidden/);
  }

  for (const resultsSource of [imagePickerSource, coverPickerSource]) {
    assert.match(
      resultsSource,
      /class="[^"]*min-h-0 flex-1 overflow-y-auto overscroll-contain[^"]*"\s+data-media-results/,
    );
    assert.match(resultsSource, /aria-busy=/);
    assert.match(resultsSource, /role="alert"/);
    assert.match(resultsSource, /editor\.libraryEmpty/);
    assert.match(resultsSource, /editor\.loadMoreImages/);
    assert.match(resultsSource, /editor\.gridView/);
    assert.match(resultsSource, /editor\.listView/);
    assert.match(resultsSource, /aria-pressed=/);
    assert.match(resultsSource, /grid-cols-2/);
    assert.match(resultsSource, /flex min-h-20 items-center/);
  }
});

test("authenticated editors can generate an AI cover that is used whole", () => {
  assert.match(
    coverFieldSource,
    /\{#if \$isAuthenticated\}[\s\S]*<Tabs\.Trigger value="ai">/,
  );
  assert.match(coverFieldSource, /<CoverAIPanel/);
  assert.match(coverFieldSource, /onChoose=\{beginCropFromGeneratedFile\}/);
  assert.match(coverAIPanelSource, /\/api\/openai\/image/);
  assert.match(coverAIPanelSource, /size: "1536x1024"/);
  assert.match(
    coverAIPanelSource,
    /prompt: generationPrompt[\s\S]*size: "1536x1024"/,
  );
  assert.match(coverAIPanelSource, /selectedModel\.price_2z/);
  assert.match(coverAIPanelSource, /Free2Z charge: \{price\} 2Z/);
  assert.doesNotMatch(coverAIPanelSource, /Costs 6 2Zs/);
  assert.match(
    coverAIPanelSource,
    /selectedChoice = event\.currentTarget\.value;[\s\S]*acceptedTerms = false;/,
  );
  assert.match(coverAIPanelSource, /!acceptedTerms/);
  assert.match(coverAIPanelSource, /choice_snapshot: snapshotToken/);
  assert.match(coverAIPanelSource, /response\.status === 402/);
  assert.match(coverAIPanelSource, /insufficientFunds = funds/);
  assert.match(
    coverAIPanelSource,
    /<InsufficientFunds[\s\S]{0,100}funds=\{insufficientFunds\}/,
  );

  // The composition guidance used to ask for an ultra-wide frame "designed for
  // a 4:1 (1600 x 400) crop", with expendable background above and below. No
  // surface crops any more  and the editor imposes no shape
  //, so that guidance was steering the model toward the single worst
  // shape to store: 4:1 maximises the blur pad on the square thumbnail.
  //
  // Checked against the guidance string itself, not the whole file — the file
  // also carries the comment explaining what the old guidance was and why it
  // went, which is the record this change should leave behind.
  const guidance = coverAIPanelSource.match(
    /COVER_COMPOSITION_GUIDANCE =\s*\n?\s*"((?:[^"\\]|\\.)*)"/,
  )?.[1];
  assert.ok(guidance, "could not find the composition guidance string");
  assert.doesNotMatch(guidance, /1600/);
  assert.doesNotMatch(guidance, /4:1/);
  assert.doesNotMatch(guidance, /central horizontal band/);
  assert.match(guidance, /shown whole, never cropped/);
  // And the generated image is previewed whole rather than cover-cropped into
  // a 7:4 box it does not match — the preview was lying about its own output.
  assert.doesNotMatch(coverAIPanelSource, /aspect-\[7\/4\]/);
  assert.match(coverAIPanelSource, /Use This Image/);
});

test("device image workspace fills the tab and accepts drag, drop, and paste", () => {
  assert.match(
    imagePickerSource,
    /value="device"[\s\S]*class="flex min-h-0 flex-col overflow-hidden"/,
  );
  assert.match(imagePickerSource, /ondragenter=\{handleLocalDrag\}/);
  assert.match(imagePickerSource, /ondragover=\{handleLocalDrag\}/);
  assert.match(imagePickerSource, /ondrop=\{handleLocalDrop\}/);
  assert.match(
    imagePickerSource,
    /<svelte:window onpaste=\{handleLocalPaste\} \/>/,
  );
  assert.match(imagePickerSource, /imageFilesFromClipboard/);
  assert.match(imagePickerSource, /event\.clipboardData/);
  assert.match(imagePickerSource, /Paste with ⌘\/Ctrl \+ V/);
  assert.match(imagePickerSource, /data-drag-active=\{localDragActive\}/);
  assert.match(imagePickerSource, /Drop images anywhere here/);
});

test("media links resolve to a complete absolute URL without corrupting encoded names", () => {
  const encodedPath = "/uploadz/c%CE%94rov%CE%A3r0/a.mp4";

  assert.equal(
    resolveMediaUrl(encodedPath, "", "https://free2z.com"),
    "https://free2z.com/uploadz/c%CE%94rov%CE%A3r0/a.mp4",
  );
  assert.equal(
    resolveMediaUrl(
      encodedPath,
      "https://media.free2z.com",
      "https://free2z.com",
    ),
    "https://media.free2z.com/uploadz/c%CE%94rov%CE%A3r0/a.mp4",
  );
  assert.equal(
    resolveMediaUrl(
      "https://cdn.free2z.com/uploadz/c%CE%94rov%CE%A3r0/a.mp4",
      "https://media.free2z.com",
      "https://free2z.com",
    ),
    "https://cdn.free2z.com/uploadz/c%CE%94rov%CE%A3r0/a.mp4",
  );
  assert.equal(isPreviewableMedia("video/mp4", encodedPath), true);
});

test("copy link produces a complete absolute URL for every upload name (#577)", () => {
  // Production runs with PUBLIC_API_BASE_URL="" (k8s/new-ui/deployment.yaml),
  // exactly the configuration in which the helper handed back a bare
  // "/uploadz/..." path — "only part of the URL" on the clipboard.
  const origin = "https://free2z.cash";
  const cases = [
    // the repro from the issue: percent-encoded multibyte path segment
    ["/uploadz/c%CE%94rov%CE%A3r0/a.mp4", "/uploadz/c%CE%94rov%CE%A3r0/a.mp4"],
    // the same path already decoded — must encode back to identical bytes
    ["/uploadz/c\u0394rov\u03a3r0/a.mp4", "/uploadz/c%CE%94rov%CE%A3r0/a.mp4"],
    // plain ASCII
    ["/uploadz/public/kevin/photo.png", "/uploadz/public/kevin/photo.png"],
    // spaces, raw and pre-encoded
    [
      "/uploadz/public/kevin/my holiday.mp4",
      "/uploadz/public/kevin/my%20holiday.mp4",
    ],
    [
      "/uploadz/public/kevin/my%20holiday.mp4",
      "/uploadz/public/kevin/my%20holiday.mp4",
    ],
    // a literal percent in the name must not be double-decoded
    [
      "/uploadz/public/kevin/100%25-done.webm",
      "/uploadz/public/kevin/100%25-done.webm",
    ],
    // video extensions
    ["/uploadz/public/kevin/clip.mov", "/uploadz/public/kevin/clip.mov"],
    ["/uploadz/public/kevin/clip.webm", "/uploadz/public/kevin/clip.webm"],
  ];

  for (const [stored, expectedPath] of cases) {
    assert.equal(
      absoluteMediaUrl(stored, "", origin),
      `${origin}${expectedPath}`,
      `absolute URL for ${stored}`,
    );
  }

  // The copied value must survive a round trip through the URL parser
  // unchanged — byte-for-byte usable, not merely displayable.
  for (const [stored] of cases) {
    const copied = absoluteMediaUrl(stored, "", origin);
    assert.equal(new URL(copied).href, copied);
  }

  // A configured API base still wins over the document origin.
  assert.equal(
    absoluteMediaUrl(
      "/uploadz/c%CE%94rov%CE%A3r0/a.mp4",
      "https://media.free2z.cash",
      origin,
    ),
    "https://media.free2z.cash/uploadz/c%CE%94rov%CE%A3r0/a.mp4",
  );
});

test("a relative media path can never escape to another origin (#630)", () => {
  // WHATWG URL parsing treats a backslash as a slash in a special URL, so
  // "/\\evil.example/x" is protocol-relative: it resolves to
  // https://evil.example/x, which passes any scheme check because it
  // genuinely IS https — to somebody else's origin.
  //
  // The sharp part: it is harmless when apiBase is set (the escape lands in
  // the path of the API host) and escapes only when apiBase is "" — which
  // is production (k8s/new-ui/deployment.yaml sets PUBLIC_API_BASE_URL: "").
  // Both shapes are asserted so a passing dev config can't hide it.
  const origin = "https://free2z.cash";
  const escapes = [
    "/\\evil.example/x",
    // Path-shaped values that are not the one protocol-relative form we
    // honour, but which a browser still resolves to another origin.
    "///evil.example/x",
    "//\\evil.example/x",
    "/\\\\evil.example/x",
    "\\\\evil.example/x",
    "/\\evil.example/uploadz/public/kevin/photo.png",
  ];

  for (const hostile of escapes) {
    // Production shape: no API base, so the browser resolves it against the
    // document origin and lands off-site.
    assert.equal(
      absoluteMediaUrl(hostile, "", origin),
      "",
      `escaped with apiBase="": ${hostile}`,
    );
    assert.equal(resolveMediaUrl(hostile, "", origin), "");
    // Dev shape (apiBase set) is where this does NOT reproduce; the value is
    // still junk, so it must not be handed out there either.
    assert.equal(
      absoluteMediaUrl(hostile, "https://api.free2z.cash", origin),
      "",
      `leaked with an apiBase: ${hostile}`,
    );
    // And the img/video `src` path, which returns a relative value.
    assert.equal(resolveMediaUrl(hostile, "", ""), "");
  }

  // Nothing legitimate is caught by this: ordinary paths still resolve, and
  // an explicitly absolute or protocol-relative URL from the API is still a
  // deliberate cross-origin statement we honour.
  assert.equal(
    absoluteMediaUrl("/uploadz/public/kevin/photo.png", "", origin),
    `${origin}/uploadz/public/kevin/photo.png`,
  );
  assert.equal(
    absoluteMediaUrl("/uploadz/c%CE%94rov%CE%A3r0/a.mp4", "", origin),
    `${origin}/uploadz/c%CE%94rov%CE%A3r0/a.mp4`,
  );
  assert.equal(
    absoluteMediaUrl("//cdn.free2z.cash/x.png", "", origin),
    "https://cdn.free2z.cash/x.png",
  );
  assert.equal(
    absoluteMediaUrl("https://cdn.free2z.cash/x.png", "", origin),
    "https://cdn.free2z.cash/x.png",
  );
});

test("media URLs are restricted to an http(s) scheme allow-list (#630)", () => {
  for (const hostile of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "java\nscript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ]) {
    assert.equal(isAllowedMediaUrl(hostile), false, `allowed: ${hostile}`);
    assert.equal(resolveMediaUrl(hostile, "", "https://free2z.cash"), "");
    assert.equal(absoluteMediaUrl(hostile, "", "https://free2z.cash"), "");
  }

  // Leading whitespace must not smuggle a value past the checks: the
  // browser trims it, so resolveMediaUrl has to trim it first.
  assert.equal(
    absoluteMediaUrl("  //cdn.free2z.cash/x.png", "", "https://free2z.cash"),
    "https://cdn.free2z.cash/x.png",
  );
  assert.equal(
    absoluteMediaUrl("  /uploadz/x.png  ", "", "https://free2z.cash"),
    "https://free2z.cash/uploadz/x.png",
  );

  for (const safe of [
    "/uploadz/public/kevin/photo.png",
    "https://free2z.cash/uploadz/public/kevin/photo.png",
    "http://localhost:8000/uploadz/public/kevin/photo.png",
    "//cdn.free2z.cash/uploadz/public/kevin/photo.png",
  ]) {
    assert.equal(isAllowedMediaUrl(safe), true, `blocked: ${safe}`);
    assert.notEqual(absoluteMediaUrl(safe, "", "https://free2z.cash"), "");
  }
});

function dragEvent(
  type,
  { files = [], types = ["Files"], relatedTarget } = {},
) {
  return {
    type,
    relatedTarget: relatedTarget === undefined ? {} : relatedTarget,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    dataTransfer: { types, files, dropEffect: "" },
  };
}

test("dropping a file on the upload area starts the upload (#576)", () => {
  const dropped = [];
  const states = [];
  const zone = createDropZone({
    onFiles: (files) => dropped.push(files),
    onActiveChange: (active) => states.push(active),
  });

  // Dragging in lights the target up...
  const enter = dragEvent("dragenter");
  zone.handleZoneDrag(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(states, [true]);

  //...dragover keeps it lit and MUST be cancelled, or no drop event fires.
  const over = dragEvent("dragover");
  zone.handleZoneDrag(over);
  assert.equal(over.defaultPrevented, true);
  assert.equal(over.dataTransfer.dropEffect, "copy");

  const drop = dragEvent("drop", {
    files: [{ name: "a.mp4", type: "video/mp4" }],
  });
  zone.handleZoneDrop(drop);
  assert.equal(drop.defaultPrevented, true, "browser must not open the file");
  assert.equal(
    drop.propagationStopped,
    true,
    "the window handler must not also fire",
  );
  assert.equal(dropped.length, 1);
  assert.deepEqual(states, [true, false], "active state clears after the drop");
});

test("nested children do not flicker the drop target's active state (#576)", () => {
  const states = [];
  const zone = createDropZone({
    onFiles: () => {},
    onActiveChange: (active) => states.push(active),
  });

  zone.handleZoneDrag(dragEvent("dragenter")); // the zone
  zone.handleZoneDrag(dragEvent("dragenter")); // an inner element
  zone.handleZoneDrag(dragEvent("dragleave")); // leaves it, still inside
  assert.deepEqual(states, [true], "no off/on churn while inside the zone");

  zone.handleZoneDrag(dragEvent("dragleave")); // leaves the zone for real
  assert.deepEqual(states, [true, false]);
});

test("leaving the window and stray drops clear the drop target (#576)", () => {
  const states = [];
  let strayDrops = 0;
  const zone = createDropZone({
    onFiles: () => {},
    onActiveChange: (active) => states.push(active),
    onStrayDrop: () => {
      strayDrops += 1;
    },
  });

  zone.handleZoneDrag(dragEvent("dragenter"));
  zone.handleWindowDragLeave(dragEvent("dragleave", { relatedTarget: null }));
  assert.deepEqual(states, [true, false], "no stuck overlay after leaving");

  // A drop anywhere else on the page must be swallowed: the browser's
  // default action is to navigate to the dropped file.
  zone.handleZoneDrag(dragEvent("dragenter"));
  const strayOver = dragEvent("dragover");
  zone.handleWindowDragOver(strayOver);
  assert.equal(strayOver.defaultPrevented, true);
  const stray = dragEvent("drop", { files: [{ name: "a.mp4" }] });
  zone.handleWindowDrop(stray);
  assert.equal(stray.defaultPrevented, true);
  assert.equal(strayDrops, 1, "the user is told where to drop");
  assert.deepEqual(states, [true, false, true, false]);
});

test("text drags are ignored by the drop zone (#576)", () => {
  const states = [];
  let strayDrops = 0;
  const zone = createDropZone({
    onFiles: () => {},
    onActiveChange: (active) => states.push(active),
    onStrayDrop: () => {
      strayDrops += 1;
    },
  });

  zone.handleZoneDrag(dragEvent("dragenter", { types: ["text/plain"] }));
  const strayOver = dragEvent("dragover", { types: ["text/plain"] });
  zone.handleWindowDragOver(strayOver);
  zone.handleWindowDrop(dragEvent("drop", { types: ["text/plain"] }));

  assert.deepEqual(states, [], "selecting text never lights the drop target");
  assert.equal(strayOver.defaultPrevented, false, "text drops stay native");
  assert.equal(strayDrops, 0);
});

test("uploader offers preview, copy link, and open in new tab once done (#578)", () => {
  // The URL comes from the API response, so every action uses the same
  // complete public URL that Copy link puts on the clipboard.
  assert.match(mediaUploaderSource, /parseUploadResponse\(xhr\.responseText\)/);
  assert.match(mediaUploaderSource, /publicUrl: created\?\.url/);
  assert.match(
    mediaUploaderSource,
    /absoluteMediaUrl\(created\.url, apiBase\)/,
  );
  assert.match(
    uploadsViewSource,
    /GenericFileSerializer\(instances, many=True\)/,
  );

  for (const action of ["preview", "copy", "open"]) {
    assert.match(
      mediaUploaderSource,
      new RegExp(`data-upload-action="${action}"`),
    );
  }
  // Open in new tab is a real link: keyboard- and touch-reachable, and it
  // never hands window.opener to the media origin.
  assert.match(
    mediaUploaderSource,
    /href=\{item\.publicUrl\}[\s\S]{0,160}target="_blank"[\s\S]{0,120}rel="noopener noreferrer"/,
  );
  // Image AND video previews, each degrading on a load error.
  assert.match(
    mediaUploaderSource,
    /<img[\s\S]{0,240}on:error=\{\(\) => markPreviewFailed/,
  );
  assert.match(
    mediaUploaderSource,
    /<video[\s\S]{0,320}on:error=\{\(\) => markPreviewFailed/,
  );
  // A failed preview hides only the preview button, never the URL actions.
  assert.match(
    mediaUploaderSource,
    /\{#if item\.status === "done" && item\.publicUrl\}/,
  );
  assert.match(
    mediaUploaderSource,
    /\{#if item\.previewUrl && !item\.previewFailed\}[\s\S]{0,700}data-upload-action="preview"/,
  );
  assert.match(mediaUploaderSource, /<MediaPreviewDialog/);
  // The stored level is labelled next to the link rather than a share being
  // advertised that 401s. The level itself is no longer hardcoded — see
  // "the uploader lets the creator choose the access level" below.
  assert.match(
    mediaUploaderSource,
    /data-upload-access=\{item\.remoteAccess\}/,
  );
  assert.match(mediaUploaderSource, /media\.privateLink/);
});

test("profile media uploader keeps drag state stable and drains files added mid-upload", () => {
  assert.match(dropZoneSource, /depth \+= 1/);
  assert.match(dropZoneSource, /dropEffect = "copy"/);
  assert.match(mediaUploaderSource, /createDropZone\(\{/);
  assert.match(mediaUploaderSource, /data-drag-active=\{dragActive\}/);
  assert.match(mediaUploaderSource, /while \(true\)/);
  assert.match(mediaUploaderSource, /status === ["']queued["']/);
  assert.match(mediaUploaderSource, /activeRequests\.get\(id\)\?\.abort\(\)/);
  // The accept list is DERIVED from the server allowlist now  — it
  // used to be five literal types, ~10 behind the server, which is how a PDF
  // came to be rejected in the browser before any request was made. The
  // derivation itself is pinned by tests/media-upload-types.test.mjs.
  assert.match(mediaUploaderSource, /accept=\{UPLOAD_ACCEPT_ATTRIBUTE\}/);
  assert.doesNotMatch(mediaUploaderSource, /accept="image\//);
  assert.match(mediaUploaderSource, /on:paste=\{handlePaste\}/);
  assert.match(mediaUploaderSource, /imageFilesFromClipboard/);
  assert.match(mediaUploaderSource, /event\.clipboardData/);
  assert.match(mediaUploaderSource, /Paste with ⌘\/Ctrl \+ V/);
});

test("profile media uploader never offers SVG — the server rejects it (#962)", () => {
  // An SVG is a scriptable document served inline from the cookie-bearing
  // free2z.cash origin, i.e. stored XSS, so the upload allowlist in
  // py/free2z/dj/apps/uploads/validation.py refuses it outright. Offering it in the
  // picker or the drag-drop filter only buys the user a 400 after the upload.
  assert.doesNotMatch(mediaUploaderSource, /image\/svg\+xml",/);
  assert.doesNotMatch(mediaUploaderSource, /accept="[^"]*svg/);
});

test("media dashboard exposes full-link sharing, preview, and open-original actions", () => {
  assert.match(mediaDashboardSource, /buildMediaUrl\(item\.url, true\)/);
  assert.match(mediaDashboardSource, /navigator\.share/);
  assert.match(mediaDashboardSource, /Copy full link/);
  assert.match(mediaDashboardSource, /MediaPreviewDialog/);
  assert.match(mediaPreviewSource, /Open original/);
  assert.match(mediaPreviewSource, /<video[\s\S]*controls/);
  assert.match(mediaPreviewSource, /<img[\s\S]*object-contain/);
  assert.match(mediaDashboardSource, /copyTextToClipboard/);
  assert.match(clipboardSource, /document\.execCommand\(["']copy["']\)/);
  assert.match(mediaDashboardSource, /data-copied=/);
  assert.match(
    mediaDashboardSource,
    /data-media-action="copy"[\s\S]{0,300}rounded-md/,
  );
  assert.match(
    mediaDashboardSource,
    /data-media-action="share"[\s\S]{0,300}rounded-md/,
  );
});

test("media dashboard searches, filters, and supports grid and list views", () => {
  assert.match(mediaDashboardSource, /params\.set\(["']search["']/);
  assert.match(mediaDashboardSource, /params\.set\(["']mime_type["']/);
  assert.match(mediaDashboardSource, /Search your files/);
  assert.match(mediaDashboardSource, /Filter files by type/);
  assert.match(mediaDashboardSource, /aria-label=\{\$t\("editor\.gridView"/);
  assert.match(mediaDashboardSource, /aria-label=\{\$t\("editor\.listView"/);
  assert.match(mediaDashboardSource, /aria-pressed=/);
  assert.match(mediaDashboardSource, /data-view=\{viewMode\}/);
  assert.match(mediaDashboardSource, /free2z-media-view/);
  assert.match(mediaDashboardSource, /No matching files/);
});

test("media dashboard sorts the complete upload history by creation date", () => {
  assert.match(mediaDashboardSource, /params\.set\([\s\S]*["']ordering["']/);
  assert.match(mediaDashboardSource, /-created_at,-id/);
  assert.match(mediaDashboardSource, /created_at,id/);
  assert.match(mediaDashboardSource, /on:click=\{toggleSortOrder\}/);
  assert.match(mediaDashboardSource, /data-sort-order=\{sortOrder\}/);
  assert.match(mediaDashboardSource, /Click to reverse order/);
  assert.match(mediaDashboardSource, /Newest first/);
  assert.match(mediaDashboardSource, /Oldest first/);
  assert.match(uploadsViewSource, /filters\.OrderingFilter/);
  assert.match(uploadsViewSource, /ordering_fields = \[[^\]]*'created_at'/);
});

test("media controls stay compact and animate refresh only after a user click", () => {
  assert.match(mediaDashboardSource, /Link copied to clipboard/);
  assert.doesNotMatch(mediaDashboardSource, /Full link copied to clipboard/);
  assert.match(mediaDashboardSource, /hidden truncate sm:inline/);
  assert.match(
    mediaDashboardSource,
    /sortOrder === ["']oldest["'] \? ["']rotate-180["'] : ["']rotate-0["']/,
  );
  assert.match(mediaDashboardSource, /motion-reduce:transition-none/);
  assert.match(mediaDashboardSource, /on:click=\{handleUserRefresh\}/);
  assert.match(
    mediaDashboardSource,
    /userRefreshing \? ["']animate-spin["'] : ["']["']/,
  );
  assert.doesNotMatch(mediaDashboardSource, /group-hover:rotate-180/);
});

test("the manager renders a non-previewable file as a first-class document (#1177)", () => {
  // A PDF has no thumbnail — `GenericFile.get_thumbnail()` returns None for
  // anything that is not an image — so the card must say what the file IS
  // rather than render an <img> that can only fail.
  assert.match(
    mediaDashboardSource,
    /mediaKind\(item\.mime_type, item\.name\)/,
  );
  assert.match(mediaDashboardSource, /data-media-kind=/);
  assert.match(
    mediaDashboardSource,
    /documentLabel\(item\.mime_type, item\.name\)/,
  );
  //...and the card must not fall back to an <img> for it. `thumbnail` is the
  // only image source that survives, and the server only sets it for images.
  assert.match(
    mediaDashboardSource,
    /item\.thumbnail \|\| mediaKind\(item\.mime_type, item\.name\) === "image"/,
  );
});

test("every card action works for a file with no preview (#1177)", () => {
  // Download, copy, share, delete — all four, and download must use the
  // SAME-ORIGIN href because browsers ignore `download` cross-origin.
  assert.match(mediaDashboardSource, /data-media-action="download"/);
  assert.match(mediaDashboardSource, /data-media-action="delete"/);
  assert.match(mediaDashboardSource, /data-media-action="confirm-delete"/);
  assert.match(mediaDashboardSource, /href=\{downloadHref\(item\)\}/);
  assert.match(mediaDashboardSource, /download=\{downloadName\(item\)\}/);
  assert.match(
    mediaDashboardSource,
    /const downloadHref = \(item: UploadedMedia\) => buildMediaUrl\(item\.url\);/,
  );
  // DELETE hits the ModelViewSet detail route; apiFetch attaches the CSRF
  // token Django requires.
  assert.match(mediaDashboardSource, /\/api\/myuploads\/\$\{item\.id\}\//);
  assert.match(mediaDashboardSource, /method: "DELETE"/);
  // The actions live in the info block, not in a hover-only overlay on a
  // 112px-wide list-view thumbnail, so they are reachable by touch.
  const infoBlock = mediaDashboardSource.slice(
    mediaDashboardSource.indexOf("<!-- Info -->"),
  );
  assert.match(infoBlock, /data-media-action="download"/);
  assert.match(infoBlock, /data-media-action="delete"/);
});

test("the type filter offers documents and audio, not just images and video", () => {
  // `GenericFileFilter.mime_type` is an `istartswith` filter, so the value is
  // a prefix: `application/` reaches application/pdf.
  assert.match(mediaDashboardSource, /document: "application\/"/);
  assert.match(mediaDashboardSource, /audio: "audio\/"/);
  assert.match(mediaDashboardSource, /dashboard\.media\.documents/);
  assert.match(uploadsViewSource, /filterset_class = GenericFileFilter/);
});

test("the manager's copy no longer claims it is images-and-video only (#1177)", () => {
  for (const source of [mediaDashboardSource, mediaUploaderSource]) {
    assert.doesNotMatch(source, /supported image or MP4 video/);
    assert.doesNotMatch(source, /Images & MP4/);
  }
  assert.match(mediaUploaderSource, /media\.supportedTypesHint/);
  assert.match(mediaUploaderSource, /media\.unsupportedFile/);
  assert.match(
    mediaDashboardSource,
    /Upload an image, video, audio file or PDF document/,
  );
});

// ---------------------------------------------------------------------------
// Access levels ( follow-up): the new dashboard rendered `access` as a
// read-only badge, so a creator could not change it at all — while the backend
// had supported all three tiers the whole time.
// ---------------------------------------------------------------------------

test("the three access tiers are the ones the server enforces", () => {
  // Derived, not restated. If a tier is ever added or renamed in
  // `GenericFile.ACCESS_CHOICES`, the picker that claims to cover them must go
  // red rather than quietly offering two of three.
  const choicesBlock = uploadsModelSource.match(
    /ACCESS_CHOICES\s*=\s*\[([\s\S]*?)\n\]/,
  )?.[1];
  assert.ok(choicesBlock, "could not find ACCESS_CHOICES in models.py");
  const serverTiers = [...choicesBlock.matchAll(/\[\s*['"]([a-z]+)['"]/g)].map(
    (m) => m[1],
  );

  assert.deepEqual(
    [...MEDIA_ACCESS_LEVELS].sort(),
    [...serverTiers].sort(),
    "the client's tiers must be exactly the server's",
  );
  assert.deepEqual([...serverTiers].sort(), ["members", "private", "public"]);
});

test("only a non-private file has a link anybody else can open", () => {
  // `_public_access_ok` requires access == "public"; `_members_access_ok`
  // requires access == "members" AND owner.has_fan(user). Everything else
  // falls through both and 401s for every requester but the owner — which is
  // exactly the set of files a Share button must not appear on.
  assert.equal(isShareableAccess("public"), true);
  assert.equal(isShareableAccess("members"), true);
  assert.equal(isShareableAccess("private"), false);

  // An unreadable value is owner-only on the server too, so it must never be
  // advertised as shareable. Failing closed is the whole point.
  for (const unknown of [undefined, null, "", "PUBLIC", "everyone", "0"]) {
    assert.equal(
      isShareableAccess(unknown),
      false,
      `treated ${JSON.stringify(unknown)} as shareable`,
    );
    assert.equal(normalizeMediaAccess(unknown), "private");
  }

  assert.equal(normalizeMediaAccess("public"), "public");
  assert.equal(normalizeMediaAccess("members"), "members");
  assert.equal(normalizeMediaAccess("private"), "private");

  // A file cannot be un-shared once a link is out, so an upload with no
  // explicit choice must land private — what the old React uploader did.
  assert.equal(DEFAULT_UPLOAD_ACCESS, "private");
});

test("the library can change a file's access, title and description", () => {
  // The write itself: PATCH on the owner-scoped ModelViewSet detail route,
  // through apiFetch so Django gets its CSRF token.
  assert.match(mediaDashboardSource, /method: ["']PATCH["']/);
  assert.match(
    mediaDashboardSource,
    /apiFetch\([\s\S]{0,200}\/api\/myuploads\/\$\{item\.id\}\/[\s\S]{0,200}method: ["']PATCH["']/,
  );

  // The affordance and the controls exist and are reachable.
  assert.match(mediaDashboardSource, /data-media-action="edit"/);
  assert.match(mediaDashboardSource, /data-media-action="save-edit"/);
  for (const field of ["access", "title", "description"]) {
    assert.match(
      mediaDashboardSource,
      new RegExp(`data-media-edit="${field}"`),
    );
  }
  // All three tiers are offered, not just a public/private toggle.
  for (const tier of MEDIA_ACCESS_LEVELS) {
    assert.match(mediaDashboardSource, new RegExp(`value="${tier}"`));
  }

  // The body is the CHANGED fields only, never the whole form. Replaying
  // `access` on a title-only edit turns an unrelated save into a privacy
  // write: open the dialog on a public file, let something else make it
  // private, save the title, and the stale value republishes it. There is no
  // ETag on this endpoint, so this is the whole defence.
  const changed = mediaDashboardSource.match(
    /const changedFields = \(\) => \{[\s\S]*?\n  \};/,
  )?.[0];
  assert.ok(changed, "could not find changedFields");
  assert.match(
    changed,
    /editAccess !== normalizeMediaAccess\(editTarget\.access\)/,
  );
  assert.match(changed, /editTitle !== \(editTarget\.title \|\| ""\)/);
  assert.match(
    changed,
    /editDescription !== \(editTarget\.description \|\| ""\)/,
  );
  assert.match(mediaDashboardSource, /const payload = changedFields\(\);/);
  assert.match(mediaDashboardSource, /body: JSON\.stringify\(payload\)/);
  // Nothing to send means no request at all, rather than a no-op write that
  // still bumps updated_at and still races another writer.
  assert.match(mediaDashboardSource, /Object\.keys\(payload\)\.length === 0/);
  // `mime_type` is writable on FeaturedImageSerializer but holds the SNIFFED
  // type. Nothing in a UI gets to overwrite it.
  assert.doesNotMatch(changed, /mime_type/);
});

test("the dialog says what actually happens to the link, per direction", () => {
  // `_get_prefix()` returns /uploadz/public/ ONLY for public, so a
  // private<->members change does not touch the URL at all, and the two
  // directions across the public boundary are not symmetric:
  // `uploads_auth_private` grants anything `_public_access_ok()` accepts, so
  // an old /uploadz/ link starts working the moment a file goes public.
  assert.match(uploadsViewSource, /def uploads_auth_private/);
  assert.match(
    uploadsViewSource,
    /def uploads_auth_private[\s\S]{0,3000}if _public_access_ok\(gfile\)/,
  );

  const note = mediaDashboardSource.match(
    /\$: accessNote = \(\(\) => \{[\s\S]*?\n  \}\)\(\);/,
  )?.[0];
  assert.ok(note, "could not find accessNote");
  // No note at all when nothing changed.
  assert.match(note, /if \(from === editAccess\) return ""/);
  // Three distinct outcomes, not one blanket warning.
  assert.match(note, /dashboard\.media\.accessNoteLeavingPublic/);
  assert.match(note, /dashboard\.media\.accessNoteBecomingPublic/);
  assert.match(note, /dashboard\.media\.accessNoteRestrictedSwap/);
  // The private<->members case must NOT claim the link changes.
  assert.match(
    localeMessages.en.dashboard.media.accessNoteRestrictedSwap,
    /link stays the same/,
  );
});

test("an access change takes the server's whole object, not just the string", () => {
  // `GenericFile._get_prefix()` derives the URL prefix from `access`, so a
  // public<->private flip rewrites url, thumbnail, thumb/card/banner and every
  // variants[].url. Patching the string locally leaves the thumbnail and the
  // copy-link button pointed at a prefix that now 401s.
  assert.match(uploadsModelSource, /def _get_prefix\(self\)/);
  assert.match(uploadsModelSource, /return ["']\/uploadz\/public\/["']/);

  const merge = mediaDashboardSource.match(
    /const applyUpdatedItem =[\s\S]*?\n  \};/,
  )?.[0];
  assert.ok(merge, "could not find applyUpdatedItem");
  // The replacement is a spread of the SERVER's object...
  assert.match(merge, /\.\.\.updated,/);
  //...and it is what actually lands in `media`, and in an open preview.
  assert.match(merge, /media = media\.map\(/);
  assert.match(merge, /previewItem\?\.id === id/);
  // sizeBytes comes from our own HEAD, not the serializer, so it survives.
  assert.match(merge, /sizeBytes: entry\.sizeBytes/);

  // And that object is the parsed PATCH response, applied in place — no
  // refetch on the happy path, so the scroll/pagination position survives.
  assert.match(
    mediaDashboardSource,
    /const updated = await response\.json\(\)[\s\S]{0,400}applyUpdatedItem\(item\.id, updated/,
  );
});

test("share is not offered for a file only its owner can open", () => {
  // The complaint that started this: a Share button on a private file
  // advertises a link that 401s for every recipient.
  assert.match(
    mediaDashboardSource,
    /\{#if isShareableAccess\(item\.access\)\}[\s\S]{0,400}data-media-action="share"/,
  );
  // Copy stays on every row — the owner still wants the URL — but it says who
  // the link works for instead of implying it works for everyone.
  const copyIndex = mediaDashboardSource.indexOf('data-media-action="copy"');
  const shareGuardIndex = mediaDashboardSource.indexOf(
    "{#if isShareableAccess(item.access)}",
  );
  assert.ok(copyIndex > -1 && shareGuardIndex > -1);
  assert.ok(
    copyIndex < shareGuardIndex,
    "copy must sit outside the shareable guard",
  );
  assert.match(mediaDashboardSource, /linkNote\(item\.access\)/);
  assert.match(mediaDashboardSource, /dashboard\.media\.linkPrivateNote/);
  assert.match(mediaDashboardSource, /dashboard\.media\.linkCopiedPrivate/);

  // The same rule inside the preview dialog, which has its own Share button.
  assert.match(
    mediaDashboardSource,
    /canShare=\{isShareableAccess\(previewItem\.access\)\}/,
  );
  assert.match(
    mediaPreviewSource,
    /\{#if canShare\}[\s\S]{0,400}onclick=\{onShare\}/,
  );
  // The uploader's own preview dialog had a Share button wired to nothing at
  // all, on files that upload private by default.
  assert.match(
    mediaUploaderSource,
    /canShare=\{isShareableAccess\(previewItem\.remoteAccess\)\}/,
  );
  assert.match(mediaUploaderSource, /onCopy=\{copyPreviewUrl\}/);
  //...and a Share button that IS shown has to do something. Both handlers
  // were absent, so both fell through to MediaPreviewDialog's no-op defaults;
  // that was invisible while every upload was private.
  assert.match(mediaUploaderSource, /onShare=\{sharePreviewUrl\}/);
  assert.match(mediaUploaderSource, /const sharePreviewUrl = async \(\)/);
  assert.match(mediaUploaderSource, /navigator\.share/);
});

test("the uploader lets the creator choose the access level", () => {
  // It used to send a hardcoded `access: "private"` for every file, with no
  // way to change it before or after — the old FileUploadForm had a per-file
  // select.
  assert.doesNotMatch(mediaUploaderSource, /access: ["']private["']/);
  assert.match(mediaUploaderSource, /data-upload-access-picker/);
  assert.match(mediaUploaderSource, /bind:value=\{uploadAccess\}/);
  // The chosen level is captured when the file is DROPPED and carried on the
  // queue item, so changing the picker mid-batch cannot retroactively publish
  // a file that is already queued or uploading.
  //
  // Asserted by POSITION, not by presence. `access: uploadAccess` inside the
  // queue-item literal read as correct for as long as `addFiles` was
  // synchronous; the moment an await appeared in front of it (the server-side
  // size confirmation) the same text became a race that could publish a file
  // dropped as private. What has to hold is that the sample happens before
  // anything is awaited. (Raised by the codex review of the upload-limit PR.)
  // Comments stripped first: the one explaining this very hazard contains the
  // word "await", and would otherwise be found before the code.
  const addFilesBody = mediaUploaderSource
    .slice(
      mediaUploaderSource.indexOf("const addFiles"),
      mediaUploaderSource.indexOf("const imageFilesFromClipboard"),
    )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.notEqual(addFilesBody.length, 0);
  const sampledAt = addFilesBody.search(
    /const\s+access\s*=\s*uploadAccess\s*;/,
  );
  assert.notEqual(sampledAt, -1, "addFiles must sample the picker itself");
  const firstAwait = addFilesBody.search(/\bawait\b/);
  if (firstAwait !== -1) {
    assert.ok(
      sampledAt < firstAwait,
      "the access level must be sampled BEFORE addFiles awaits anything",
    );
  }
  assert.match(addFilesBody, /file,\s*access,/);
  assert.match(
    mediaUploaderSource,
    /access: normalizeMediaAccess\(item\.access\)/,
  );
  assert.match(
    mediaUploaderSource,
    /let uploadAccess: MediaAccess = DEFAULT_UPLOAD_ACCESS/,
  );
  for (const tier of MEDIA_ACCESS_LEVELS) {
    assert.match(mediaUploaderSource, new RegExp(`value="${tier}"`));
  }
  // GenericFileSerializer.access is a ChoiceField (the model field carries
  // choices), so a junk value is a 400 rather than a stored surprise.
  assert.match(uploadsModelSource, /choices=ACCESS_CHOICES/);
});

test("the library can be filtered by access level", () => {
  assert.match(
    mediaDashboardSource,
    /params\.set\(["']access["'], accessFilter\)/,
  );
  assert.match(mediaDashboardSource, /data-media-filter="access"/);
  assert.match(uploadsViewSource, /filterset_class = GenericFileFilter/);

  // Clearing filters clears this one too, and the "no matching files" state
  // must recognise an access-only filter or it tells the user their library is
  // empty when it is not.
  const clear = mediaDashboardSource.match(
    /const clearFilters =[\s\S]*?\n  \};/,
  )?.[0];
  assert.ok(clear, "could not find clearFilters");
  assert.match(clear, /accessFilter = ["']all["']/);
  assert.match(
    mediaDashboardSource,
    /\{#if searchQuery\.trim\(\)[\s\S]{0,120}accessFilter !== ["']all["']\}/,
  );
});

test("every access string the media surfaces show is translated everywhere", () => {
  // These strings are the whole feature: a picker whose options fall back to
  // English in three of four locales is not a picker anybody can use.
  const keysOf = (messages, path) =>
    Object.keys(path.split(".").reduce((node, part) => node[part], messages));

  for (const namespace of ["dashboard.media", "media"]) {
    const english = keysOf(localeMessages.en, namespace);
    for (const accessKey of [
      "accessPublic",
      "accessMembers",
      "accessPrivate",
    ]) {
      assert.ok(
        english.includes(accessKey),
        `en is missing ${namespace}.${accessKey}`,
      );
    }
    for (const name of localeNames) {
      assert.deepEqual(
        keysOf(localeMessages[name], namespace).sort(),
        [...english].sort(),
        `${name} does not carry the same ${namespace} keys as en`,
      );
    }
  }

  // "Members" was the old label for the tier the owner calls subscribers-only.
  assert.equal(localeMessages.en.dashboard.media.accessMembers, "Subscribers");
});

test("media search shows only the styled clear button", () => {
  assert.match(
    mediaDashboardSource,
    /type="search"[\s\S]{0,800}\[&::-webkit-search-cancel-button\]:hidden/,
  );
  assert.match(
    mediaDashboardSource,
    /aria-label=\{\$t\("dashboard\.media\.clearSearch"/,
  );
});
