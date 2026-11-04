import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite;
let streamRetryDelay;

before(async () => {
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  ({ streamRetryDelay } = await vite.ssrLoadModule(
    "/src/lib/utils/stream-recovery.ts",
  ));
});

after(async () => {
  await vite?.close();
});

test("retry backoff grows exponentially and stops growing at the cap", () => {
  const noJitter = () => 0.5;
  assert.deepEqual(
    [0, 1, 2, 3, 4, 8].map((attempt) => streamRetryDelay(attempt, noJitter)),
    [1000, 2000, 4000, 8000, 16000, 30000],
  );
  assert.equal(streamRetryDelay(100, noJitter), 30000);
});

test("retry jitter remains within 75% to 125% of each capped delay", () => {
  assert.equal(
    streamRetryDelay(2, () => 0),
    3000,
  );
  assert.equal(
    streamRetryDelay(2, () => 1),
    5000,
  );
  assert.equal(
    streamRetryDelay(8, () => 1),
    30000,
  );
});

test("the live and private routes keep provider meetings mounted under overlays", async () => {
  const { readFile } = await import("node:fs/promises");
  const live = await readFile(
    new URL(
      "../src/lib/components/stream/LiveStreamViewer.svelte",
      import.meta.url,
    ),
    "utf8",
  );
  const privateRoute = await readFile(
    new URL(
      "../src/routes/[username]/private/[secret]/+page.svelte",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(live, /\{#if meeting\b[\s\S]*?<InlineRtkMeeting/);
  assert.match(live, /connectionStatus === "disconnected"[\s\S]*?Reconnecting/);
  assert.match(privateRoute, /\{#if meeting\}[\s\S]*?<rtk-meeting/);
  assert.match(privateRoute, /connectionStatus === "disconnected"/);
});
