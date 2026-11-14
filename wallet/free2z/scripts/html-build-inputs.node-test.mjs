// Load the actual Vite config: the route audit's HTML input registry must be
// the real build contract, with evaluation excluded by default.
import test from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";

const app = fileURLToPath(new URL("../", import.meta.url));
test("actual Vite HTML inputs exist and include evaluation only on opt-in", async () => {
  const previous = process.env.VITE_LOCAL_DRAFT_EVALUATION;
  try {
    for (const enabled of [false, true]) {
      if (enabled) process.env.VITE_LOCAL_DRAFT_EVALUATION = "1";
      else delete process.env.VITE_LOCAL_DRAFT_EVALUATION;
      const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, path.join(app, "vite.config.ts"));
      assert.ok(loaded, "actual Vite configuration must load");
      const inputs = loaded.config.build?.rollupOptions?.input;
      assert.deepEqual(inputs, {
        main: path.join(app, "index.html"),
        ...(enabled ? { localDraft: path.join(app, "local-draft.html") } : {}),
      });
      for (const file of Object.values(inputs)) assert.ok((await stat(file)).isFile());
    }
  } finally {
    if (previous === undefined) delete process.env.VITE_LOCAL_DRAFT_EVALUATION;
    else process.env.VITE_LOCAL_DRAFT_EVALUATION = previous;
  }
});
