import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { recorderBuildProcesses } from "./helpers/recorder-build-processes.mjs";

const script = fileURLToPath(
  new URL("../scripts/build-recorder.mjs", import.meta.url),
);
const probe = fileURLToPath(
  new URL("./helpers/recorder-service-probe.mjs", import.meta.url),
);
for (const mode of ["success", "error", "exported"]) {
  test(
    `recorder compiler ownership after ${mode}`,
    { timeout: 30_000 },
    async (t) => {
      const processes = recorderBuildProcesses(t.signal);
      const output = await mkdtemp(join(tmpdir(), "free2z-recorder-service-"));
      try {
        if (mode === "error") {
          await processes.run([script, output]);
          const html = await readFile(
            join(output, "tools/recording/index.html"),
            "utf8",
          );
          const prefix = html.match(
            /src="(\/_app\/immutable\/recorder\/[a-f0-9]+\/)app\.js"/,
          )?.[1];
          assert.ok(prefix);
          const ui = join(output, prefix, "ui");
          await unlink(join(ui, (await readdir(ui))[0]));
        }
        await processes.run([probe, script, output, mode]);
      } finally {
        await processes.close();
        await rm(output, { recursive: true, force: true });
      }
    },
  );
}
