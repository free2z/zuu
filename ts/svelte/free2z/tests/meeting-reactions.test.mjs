import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../src/lib/utils/meeting-reactions.ts", import.meta.url),
  "utf8",
);
describe("meeting reaction control contract", () => {
  it("uses versioned anonymous broadcasts and bounded controls", async () => {
    assert.match(source, /free2z:meeting-reaction:v1/);
    assert.match(source, /RECEIVE_LIMIT = 12/);
    assert.match(source, /MAX_VISIBLE = 8/);
    const component = await readFile(
      new URL(
        "../src/lib/components/stream/InlineRtkMeeting.svelte",
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(component, /aria-label={`Send \$\{emoji\} reaction`}/);
    assert.match(component, /broadcastMessage\(REACTION_EVENT, payload\)/);
    assert.match(component, /prefers-reduced-motion/);
  });
});
