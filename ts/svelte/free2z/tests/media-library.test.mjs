import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { appendMediaPage } from "../src/lib/components/mdEditor/mediaLibrary.js";
import {
  isPreviewableMedia,
  resolveMediaUrl,
} from "../src/lib/components/media/mediaUrl.js";

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
const uploadsViewSource = await readFile(
  new URL("../../../../py/dj/apps/uploads/views.py", import.meta.url),
  "utf8",
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

test("authenticated editors can generate a wide AI cover before cropping", () => {
  assert.match(
    coverFieldSource,
    /\{#if \$isAuthenticated\}[\s\S]*<Tabs\.Trigger value="ai">/,
  );
  assert.match(coverFieldSource, /<CoverAIPanel/);
  assert.match(coverFieldSource, /onChoose=\{beginCropFromGeneratedFile\}/);
  assert.match(coverAIPanelSource, /\/api\/openai\/image/);
  assert.match(coverAIPanelSource, /size: "1792x1024"/);
  assert.match(coverAIPanelSource, /designed for a 4:1 \(1600 x 400\) crop/);
  assert.match(
    coverAIPanelSource,
    /prompt: generationPrompt[\s\S]*size: "1792x1024"/,
  );
  assert.match(coverAIPanelSource, /central horizontal band/);
  assert.match(coverAIPanelSource, /Costs 5 2Zs/);
  assert.match(coverAIPanelSource, /response\.status === 403/);
  assert.match(coverAIPanelSource, /You have not been charged/);
  assert.match(coverAIPanelSource, /Crop and Use/);
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

test("profile media uploader keeps drag state stable and drains files added mid-upload", () => {
  assert.match(mediaUploaderSource, /let dragDepth = 0/);
  assert.match(mediaUploaderSource, /dragDepth \+= 1/);
  assert.match(
    mediaUploaderSource,
    /event\.dataTransfer\.dropEffect = ["']copy["']/,
  );
  assert.match(mediaUploaderSource, /while \(true\)/);
  assert.match(mediaUploaderSource, /status === ["']queued["']/);
  assert.match(mediaUploaderSource, /activeRequests\.get\(id\)\?\.abort\(\)/);
  assert.match(mediaUploaderSource, /"video\/mp4"/);
  assert.match(
    mediaUploaderSource,
    /accept="image\/jpeg,image\/png,image\/gif,image\/svg\+xml,image\/webp,video\/mp4"/,
  );
  assert.match(
    mediaUploaderSource,
    /<svelte:window on:paste=\{handlePaste\} \/>/,
  );
  assert.match(mediaUploaderSource, /imageFilesFromClipboard/);
  assert.match(mediaUploaderSource, /event\.clipboardData/);
  assert.match(mediaUploaderSource, /Paste with ⌘\/Ctrl \+ V/);
});

test("media dashboard exposes full-link sharing, preview, and open-original actions", () => {
  assert.match(mediaDashboardSource, /buildMediaUrl\(item\.url, true\)/);
  assert.match(mediaDashboardSource, /navigator\.share/);
  assert.match(mediaDashboardSource, /Copy full link/);
  assert.match(mediaDashboardSource, /MediaPreviewDialog/);
  assert.match(mediaPreviewSource, /Open original/);
  assert.match(mediaPreviewSource, /<video[\s\S]*controls/);
  assert.match(mediaPreviewSource, /<img[\s\S]*object-contain/);
  assert.match(mediaDashboardSource, /document\.execCommand\(["']copy["']\)/);
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
  assert.match(mediaDashboardSource, /Search your media/);
  assert.match(mediaDashboardSource, /Filter media by type/);
  assert.match(mediaDashboardSource, /aria-label="Grid view"/);
  assert.match(mediaDashboardSource, /aria-label="List view"/);
  assert.match(mediaDashboardSource, /aria-pressed=/);
  assert.match(mediaDashboardSource, /data-view=\{viewMode\}/);
  assert.match(mediaDashboardSource, /free2z-media-view/);
  assert.match(mediaDashboardSource, /No matching media/);
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
  assert.match(
    mediaDashboardSource,
    /data-sort-order=\{sortOrder\}[\s\S]{0,800}hidden truncate sm:inline/,
  );
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

test("media search shows only the styled clear button", () => {
  assert.match(
    mediaDashboardSource,
    /type="search"[\s\S]{0,500}\[&::-webkit-search-cancel-button\]:hidden/,
  );
  assert.match(mediaDashboardSource, /aria-label="Clear search"/);
});
