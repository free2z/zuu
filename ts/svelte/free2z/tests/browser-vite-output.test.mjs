import test from "node:test";
import assert from "node:assert/strict";
import { testViteOutput } from "../scripts/test-vite-output.mjs";
test("browser and node test servers use separate generated trees from production", () => {
  assert.equal(testViteOutput({}, 17), undefined);
  assert.equal(
    testViteOutput(
      {
        FREE2Z_BROWSER_TEST: "1",
        FREE2Z_BROWSER_OUTPUT_NAME: ".svelte-kit-test-browser-123",
      },
      17,
    ),
    ".svelte-kit-test-browser-123",
  );
  assert.throws(
    () =>
      testViteOutput(
        { FREE2Z_BROWSER_TEST: "1", FREE2Z_BROWSER_OUTPUT_NAME: "../unsafe" },
        17,
      ),
    /Invalid/,
  );
  assert.equal(
    testViteOutput({ FREE2Z_BROWSER_TEST: "1" }, 17),
    ".svelte-kit-test-17",
  );
  assert.equal(
    testViteOutput({ FREE2Z_BROWSER_TEST: "1" }, 18),
    ".svelte-kit-test-18",
  );
  assert.equal(
    testViteOutput({ NODE_TEST_CONTEXT: "child-v8" }, 19),
    ".svelte-kit-test-19",
  );
});
