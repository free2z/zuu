import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const PROFILE = "src/routes/[username]/dashboard/profile/+page.svelte";
const source = readFileSync(
  fileURLToPath(new URL(`../${PROFILE}`, import.meta.url)),
  "utf8",
);

// These mirror the shapes that exposed the production bug. They document why
// the row contract requires wrapping instead of `truncate`, even though this
// repository does not yet have a browser layout harness.
const LONG_TITLE =
  "A production-shaped creator title that stays readable on narrow mobile screens";
const UNBROKEN_TITLE = "z".repeat(80);

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function openingTagForTestId(testId) {
  const marker = `data-testid="${testId}"`;
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `${PROFILE} must retain ${marker}`);
  const start = source.lastIndexOf("<a", markerIndex);
  const end = source.indexOf(">", markerIndex);
  assert.notEqual(start, -1, `${testId} must remain an anchor`);
  assert.notEqual(end, -1, `${testId} anchor must have a closing bracket`);
  return source.slice(start, end + 1);
}

test("profile title fixtures cover production-shaped wrapping pressure", () => {
  assert.ok(LONG_TITLE.length >= 60 && LONG_TITLE.length <= 90);
  assert.match(LONG_TITLE, /\s/);
  assert.equal(UNBROKEN_TITLE.length, 80);
  assert.doesNotMatch(UNBROKEN_TITLE, /\s/);
});

test("mobile stat tiles stack without truncating interface copy", () => {
  const sectionStart = source.indexOf(
    '<section class="grid grid-cols-2 gap-4 sm:grid-cols-4">',
  );
  const sectionEnd = source.indexOf("</section>", sectionStart);
  assert.notEqual(sectionStart, -1, "stats section must exist");
  assert.notEqual(sectionEnd, -1, "stats section must close");
  const stats = source.slice(sectionStart, sectionEnd);

  assert.equal(
    occurrences(
      stats,
      'class="flex flex-col items-start gap-2 p-4 sm:flex-row sm:items-center sm:gap-3"',
    ),
    4,
    "all four stat tiles must stack on mobile",
  );
  assert.equal(
    occurrences(stats, "text-xl font-bold tabular-nums sm:text-2xl"),
    4,
    "all four stat values must use the measured responsive size",
  );
  assert.doesNotMatch(
    stats,
    /\btruncate\b/,
    "interface copy must never truncate",
  );

  for (const testId of ["stat-balance", "stat-fans"]) {
    assert.match(
      openingTagForTestId(testId),
      /col-span-2 sm:col-span-1/,
      `${testId} must span the mobile grid without leaving a hole`,
    );
  }
});

test("draft and published rows shrink while user titles wrap and clamp", () => {
  assert.equal(
    occurrences(
      source,
      'class="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"',
    ),
    2,
    "both page rows must stretch their mobile children to the available width",
  );
  assert.doesNotMatch(
    source,
    /flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center/,
  );
  assert.equal(
    occurrences(
      source,
      'class="line-clamp-2 pr-4 text-base font-semibold break-words text-foreground"',
    ),
    2,
    "long and unbroken user-authored titles must wrap before clamping",
  );
});
