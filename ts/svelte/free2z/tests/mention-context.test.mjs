import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createServer } from "vite";

const server = await createServer({
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
const { countMentionCandidates } = await server.ssrLoadModule(
  "/src/lib/components/mdEditor/mentionContext.ts",
);

test.after(async () => server.close());

test("preview follows the publish parser's exclusions and relative autocomplete form", () => {
  const corpus = [
    "[@alice][profile]",
    "[profile]: https://example.test",
    "<pre>@bob</pre>",
    "[@carol](https://evil.test/carol)",
    "\\@dave",
    "@erin @frank [@erin](/erin)",
  ].join("\n");

  assert.equal(countMentionCandidates(corpus), 2);
});

test("preview keeps punctuation and does not count email partials", () => {
  assert.equal(
    countMentionCandidates(
      "@.alice @bob+news @carol-name @dave_name " +
        "email bob+news@example.com partial@carol-name",
    ),
    4,
  );
});

test("preview copy is explicitly approximate and server-authoritative", async () => {
  const sheet = await readFile(
    new URL(
      "../src/lib/components/mdEditor/PublishSheet.svelte",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sheet, /About \{count\} unique people are mentioned/);
  assert.match(sheet, /validates the final title, description, and body/);
  assert.match(sheet, /approximate body-only preview/);
});
