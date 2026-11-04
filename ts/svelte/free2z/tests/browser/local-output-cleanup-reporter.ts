import type {
  FullConfig,
  FullResult,
  Reporter,
} from "@playwright/test/reporter";

import { cleanupAfterLocalRun } from "./output";

export default class LocalOutputCleanupReporter implements Reporter {
  private outputDir = "";
  private configFile: string | undefined;
  private status = "";

  onBegin(config: FullConfig) {
    this.outputDir = config.projects[0]?.outputDir ?? "";
    this.configFile = config.configFile;
  }

  onEnd(result: FullResult) {
    this.status = result.status;
  }

  async onExit() {
    await cleanupAfterLocalRun({
      status: this.status,
      configFile: this.configFile,
      configuredOutputDir: this.outputDir,
    });
  }
}
