import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { performance } from "node:perf_hooks";
import { createServer } from "vite";

let server, plainSocialCardText, plainSocialCardSummaryText, truncateOgText;
before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ plainSocialCardText, plainSocialCardSummaryText, truncateOgText } =
    await server.ssrLoadModule("/src/lib/social-card-text.ts"));
});
after(async () => {
  await server?.close();
});

function legacy(value) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/[#*_>`~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("linear cleanup retains the renderer markup contract", () => {
  const pieces = [
    "text ",
    "[",
    "]",
    "(",
    ")",
    "![",
    "<",
    ">",
    "```",
    "**bold**",
    "\n",
    "[label](url)",
    "![alt](url)",
    "<tag>",
    "</tag>",
    "[]()",
  ];
  let state = 73542;
  for (let sample = 0; sample < 1000; sample++) {
    let value = "";
    for (let index = 0; index < 30; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      value += pieces[(state >>> 0) % pieces.length];
    }
    assert.equal(
      plainSocialCardText(value),
      truncateOgText(legacy(value), 180),
      JSON.stringify(value),
    );
  }
});

test("social card summaries omit standalone media directives and keep prose", () => {
  assert.equal(
    plainSocialCardSummaryText(
      "A day at camp.\n\n::embed[/uploadz/public/creator/video.mp4]\n\nMore about the visit.",
    ),
    "A day at camp. More about the visit.",
  );
  assert.equal(
    plainSocialCardSummaryText("The syntax `::embed[path]` is documented."),
    "The syntax ::embed[path] is documented.",
  );
});

for (const delimiter of ["<", "[", "!["]) {
  test(`100KB unmatched ${delimiter} stays within a bounded cleanup budget`, () => {
    const value = delimiter.repeat(Math.floor(100_000 / delimiter.length));
    const start = performance.now();
    const result = plainSocialCardText(value);
    const elapsed = performance.now() - start;
    assert.ok(result.length <= 1024);
    // Generous for shared CI runners; the old regexes take several seconds
    // for a single input of this size, while the linear scan takes milliseconds.
    assert.ok(elapsed < 1000, `cleanup took ${elapsed}ms`);
  });
}
