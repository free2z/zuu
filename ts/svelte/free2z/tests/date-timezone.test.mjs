//a just-charged platform fee read "in 4 hours" on the notifications
// page for a viewer in EDT. The events API sent `created_at` as
// "2026-09-28 18:00:00" (UTC, no offset) and `new Date()` reads an offset-less
// date-time as LOCAL time. These tests run in a non-UTC zone on purpose --
// under TZ=UTC, which is what CI runners default to, the bug is invisible.
//
// Negative control: in src/lib/utils/date.ts make parseApiDate return
// `new Date(text)` for strings (drop the OFFSETLESS_DATE_TIME branch). The
// offset-less cases below then fail with "in 4 hours".
process.env.TZ = "America/New_York";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server;
let date;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  date = await server.ssrLoadModule("/src/lib/utils/date.ts");
});

after(async () => {
  await server?.close();
});

// 18:00:00 UTC on 2026-09-28 is 14:00 EDT.
const NOW = Date.UTC(2026, 8, 28, 18, 0, 5);

test("the process really is in a UTC-4 zone (otherwise nothing below proves anything)", () => {
  assert.equal(new Date(NOW).getTimezoneOffset(), 240);
  //...and the platform itself still has the bug this file guards against.
  assert.equal(
    new Date("2026-09-28 18:00:00").getTime() - Date.UTC(2026, 8, 28, 18),
    4 * 3600 * 1000,
  );
});

test("an offset-less API date-time is UTC, not local time", () => {
  const expected = Date.UTC(2026, 8, 28, 18);
  for (const value of [
    "2026-09-28 18:00:00",
    "2026-09-28T18:00:00",
    "2026-09-28T18:00:00.000000",
    "2026-09-28T18:00",
  ]) {
    assert.equal(date.parseApiDate(value)?.getTime(), expected, value);
  }
  assert.equal(
    date.parseApiDate("2026-09-28T18:00:00.123456")?.getTime(),
    expected + 123,
  );
});

test("an explicit offset is honoured", () => {
  const expected = Date.UTC(2026, 8, 28, 18);
  for (const value of [
    "2026-09-28T18:00:00Z",
    "2026-09-28T18:00:00.000000Z",
    "2026-09-28T18:00:00+00:00",
    "2026-09-28T14:00:00-04:00",
  ]) {
    assert.equal(date.parseApiDate(value)?.getTime(), expected, value);
  }
});

test("empty and garbage input do not become a date", () => {
  for (const value of ["", null, undefined, "not a date"]) {
    assert.equal(date.parseApiDate(value), null);
  }
  assert.ok(Number.isNaN(date.toTimestamp("nope")));
});

test("a just-charged platform fee is 'now' in EDT, never 'in 4 hours'", () => {
  for (const createdAt of [
    "2026-09-28 18:00:00", // the pre-fix wire format
    "2026-09-28T18:00:00.123456Z", // the fixed wire format
  ]) {
    const text = date.formatRelativeTime(createdAt, "en", { now: NOW });
    assert.equal(text, "now", createdAt);
    assert.doesNotMatch(text, /^in /, createdAt);
  }
});

test("an older fee is in the past", () => {
  assert.equal(
    date.formatRelativeTime("2026-09-28 16:00:00", "en", { now: NOW }),
    "2 hours ago",
  );
  assert.equal(
    date.formatRelativeTime("2026-09-28T17:55:00Z", "en", { now: NOW }),
    "5 minutes ago",
  );
});

test("a small future offset is clock skew and reads 'now'; a large one is not hidden", () => {
  assert.equal(
    date.formatRelativeTime("2026-09-28T18:03:00Z", "en", { now: NOW }),
    "now",
  );
  assert.equal(
    date.formatRelativeTime("2026-09-28T22:00:00Z", "en", { now: NOW }),
    "in 4 hours",
  );
});

test("relative options: justNow text and absolute fallback", () => {
  assert.equal(
    date.formatRelativeTime("2026-09-28T18:00:00Z", "en", {
      now: NOW,
      justNow: "just now",
    }),
    "just now",
  );
  assert.equal(
    date.formatRelativeTime("2026-09-01T18:00:00Z", "en", {
      now: NOW,
      absoluteAfterSeconds: 7 * 86400,
      absoluteOptions: { year: "numeric", month: "short", day: "numeric" },
    }),
    "Sep 1, 2026",
  );
});

test("absolute times render in the viewer's zone", () => {
  // 02:30 UTC on the 29th is still the 28th in New York.
  assert.equal(date.formatDate("2026-09-29T02:30:00Z", "en"), "Sep 28, 2026");
  assert.equal(
    date.formatDateTime("2026-09-28 18:00:00", "en", {
      hour: "numeric",
      minute: "2-digit",
    }),
    "2:00 PM",
  );
  assert.match(
    date.formatScheduledTime("2026-09-28T18:00:00Z", "en"),
    /2:00\sPM EDT$/,
  );
});

test("a date-only value keeps its calendar date west of UTC", () => {
  assert.equal(date.formatDate("2026-09-28", "en"), "Sep 28, 2026");
});

test("unparseable input falls back to the text, or the caller's placeholder", () => {
  assert.equal(date.formatRelativeTime("soon", "en"), "soon");
  assert.equal(date.formatDate("soon", "en"), "soon");
  assert.equal(date.formatDate("soon", "en", undefined, ""), "");
  assert.equal(date.formatDate(null, "en"), "");
});

// Guard: components format dates through src/lib/utils/date.ts, which parses
// offset-less API strings as UTC. `toLocaleDateString`/`toLocaleTimeString`
// on a `new Date(apiString)` is exactly the pattern that shipped.
test("no component formats a date outside src/lib/utils/date.ts", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join, relative } = await import("node:path");
  const root = new URL("../src/", import.meta.url).pathname;
  const offenders = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (/\.(svelte|ts|js)$/.test(entry.name)) {
        const text = await readFile(path, "utf8");
        text.split("\n").forEach((line, index) => {
          if (/\.toLocale(Date|Time)String\(/.test(line)) {
            offenders.push(`${relative(root, path)}:${index + 1}`);
          }
        });
      }
    }
  }
  await walk(root);
  assert.deepEqual(
    offenders,
    [],
    "use formatDate/formatDateTime from $lib/utils/date instead",
  );
});

// Codex review of: formatScheduledTime now names the viewer's zone, so a
// caller that still appends " UTC" renders "2:00 PM EDT UTC" -- four hours
// wrong for anyone who believes the last word.
test("no caller appends a hard-coded zone to formatScheduledTime", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL(
      "../src/routes/[username]/dashboard/pages/+page.svelte",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /formatScheduledTime\(/);
  assert.doesNotMatch(source, /\}\s*UTC`/);
});
