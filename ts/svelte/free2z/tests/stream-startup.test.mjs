import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (relative) =>
  readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );

test("meeting UI chunks preload during admission and join starts with a ready UI", () => {
  const preload = read("src/lib/utils/rtk-ui.ts");
  assert.match(preload, /import\("@cloudflare\/realtimekit-ui\/loader"\)/);
  assert.match(
    preload,
    /import\("@cloudflare\/realtimekit-ui\/components\/rtk-meeting"\)/,
  );
  const viewer = read("src/lib/components/stream/LiveStreamViewer.svelte");
  assert.match(
    viewer,
    /const rtkUiReady = preloadRtkMeeting\(\);[\s\S]*?StreamService\.initStream\([\s\S]*?await rtkUiReady/,
  );
  const manager = read("src/lib/utils/rtk-manager.ts");
  assert.match(
    manager,
    /liveStreamStore\.init\(meeting, streamType, isHost\);[\s\S]*?await meeting\.join\(\)/,
  );
  assert.match(manager, /if \(!isHost && streamType !== "private"\)/);
  assert.match(manager, /rtk-init-start[\s\S]*?rtk-init-end/);
  assert.match(
    manager,
    /meeting-join-start[\s\S]*?await meeting\.join\(\)[\s\S]*?meeting-join-end/,
  );
});

test("startup locale negotiation leaves live stream routes mounted", () => {
  const layout = read("src/routes/+layout.svelte");
  assert.match(
    layout,
    /browserLocale !== data\.locale &&\s*!isLiveStreamPath\(page\.url\.pathname\)/,
  );
  assert.match(layout, /import \{ goto, invalidate, invalidateAll \}/);
  assert.match(layout, /setLocale\(browserLocale\)/);
  assert.match(
    read("src/lib/components/layout/LanguageSelector.svelte"),
    /setLocale\(nextLocale\);\s+await invalidateAll\(\);/,
  );

  const paths = read("src/lib/utils/stream-path.ts");
  assert.match(paths, /export function isLiveStreamPath/);
  assert.match(paths, /dashboard\\\/stream/);
});

test("stream startup records setup stages and the first video frame measure", () => {
  const viewer = read("src/lib/components/stream/LiveStreamViewer.svelte");
  for (const mark of [
    "viewer-mounted",
    "stream-init-start",
    "stream-init-end",
    "rtk-ui-preload-start",
    "rtk-ui-preload-end",
    "meeting-init-start",
    "meeting-init-end",
    "first-frame",
  ]) {
    assert.ok(viewer.includes(`"${mark}"`), `missing ${mark} mark`);
  }
  assert.match(viewer, /performance\.measure\([\s\S]*?"stream:first-frame"/);
  assert.match(read("src/lib/utils/rtk-ui.ts"), /requestVideoFrameCallback/);
});
