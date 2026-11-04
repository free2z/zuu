// Regression coverage for. The viewer already knows how to join every
// public stream type; these assertions protect the route and navigation wiring
// that makes those viewers reachable through shareable URLs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (relative) =>
  readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );

const PUBLIC_STREAM_TYPES = ["broadcast", "ppv", "subscribers-only"];

test("#535: public stream types have canonical pretty viewer routes", () => {
  for (const type of PUBLIC_STREAM_TYPES) {
    const route = `src/routes/[username]/${type}`;
    const server = read(`${route}/+page.server.ts`);
    const page = read(`${route}/+page.svelte`);

    assert.match(server, new RegExp(`loadLivePage\\(event, \\"${type}\\"\\)`));
    assert.match(page, /<LiveStreamPage \{data\} \/>/);
  }
});

test("#535: the legacy live route and pretty routes share loading and SEO", () => {
  assert.match(
    read("src/routes/live/[username]/+page.server.ts"),
    /loadLivePage\(event\)/,
  );
  const page = read("src/lib/components/stream/LiveStreamPage.svelte");
  // The username the API returned, not the casing the visitor typed:
  // `/SkYlAr/broadcast` and `/skylar/broadcast` are one page, and the Django
  // card tier has always canonicalised to the stored username.
  assert.match(page, /canonicalUsername = creator\?\.username \|\| username/);
  assert.match(page, /streamWatchPath\(canonicalUsername, type\)/);
  assert.match(
    page,
    /<LiveStreamViewer\s+\{username\}\s+streamType=\{type\}\s+expectedActorId=\{data.viewerActorId\}/,
  );
});

test("#535: live navigation and the host flow use the pretty viewer path", () => {
  for (const source of [
    read("src/lib/components/stream/LiveIndicator.svelte"),
    read("src/lib/components/stream/StreamSelectionModal.svelte"),
    read("src/lib/components/stream/LiveStreamViewer.svelte"),
  ]) {
    assert.match(source, /streamWatchPath\(/);
  }

  const host = read("src/routes/[username]/dashboard/stream/+page.svelte");
  assert.match(host, /streamSharePath/);
  assert.match(host, /copyStreamLink/);
  assert.match(host, /copyToClipboard\(/);
  // Copy only: the dashboard used to also LINK to the viewer page in
  // a new tab, and opening it from the broadcaster's own browser put a second
  // copy of them into the live room.
  assert.doesNotMatch(host, /href=\{streamSharePath\}/);
});
