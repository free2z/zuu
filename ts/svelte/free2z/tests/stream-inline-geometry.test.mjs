import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const VIEWER = fs.readFileSync(
  path.join(ROOT, "src/lib/components/stream/LiveStreamViewer.svelte"),
  "utf8",
);
const HOST = fs.readFileSync(
  path.join(ROOT, "src/lib/components/stream/InlineRtkMeeting.svelte"),
  "utf8",
);

test("the inline RTK host stays isolated in its extracted component", () => {
  assert.match(
    VIEWER,
    /import InlineRtkMeeting from "\.\/InlineRtkMeeting\.svelte";/,
    "the viewer must use the extracted production host component",
  );
  const inlineMeeting = VIEWER.match(/<InlineRtkMeeting\b[\s\S]*?\/>/)?.[0];
  assert.ok(
    inlineMeeting,
    "the viewer must render the production host component in its meeting branch",
  );
  assert.match(
    inlineMeeting,
    /\{meeting\}/,
    "the viewer must pass the meeting to the extracted host component",
  );
  assert.match(
    inlineMeeting,
    /translator=\{rtkTranslator\}/,
    "the viewer must pass the translator to the extracted host component",
  );
  assert.doesNotMatch(`${VIEWER}\n${HOST}`, /:global\s*\(/);
  const hostClass = HOST.match(/<rtk-meeting[\s\S]*?class="([^"]+)"/)?.[1];
  assert.ok(hostClass, "the extracted component must own the host classes");
  for (const className of [
    "rtk-meeting-host",
    "h-full",
    "min-h-0",
    "min-w-0",
    "w-full",
    "overflow-hidden",
  ]) {
    assert.ok(
      hostClass.split(/\s+/).includes(className),
      `the extracted component must keep the ${className} host class`,
    );
  }
  const hostRule = HOST.match(/\.rtk-meeting-host\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(hostRule, "the extracted host must define its scoped host rule");
  const declarations = Object.fromEntries(
    [...hostRule.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
  assert.deepEqual(declarations, {
    display: "flex",
    flex: "1 1 auto",
    "min-width": "0",
    "min-height": "0",
    width: "100%",
    height: "100%",
    overflow: "hidden",
  });
});
