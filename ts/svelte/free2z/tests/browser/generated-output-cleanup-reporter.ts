import { rm } from "node:fs/promises";
import type { Reporter } from "@playwright/test/reporter";

export default class GeneratedOutputCleanupReporter implements Reporter {
  async onExit() {
    const name = process.env.FREE2Z_BROWSER_OUTPUT_NAME;
    if (name && /^\.svelte-kit-test-browser-\d+$/.test(name))
      await rm(name, { recursive: true, force: true });
  }
}
