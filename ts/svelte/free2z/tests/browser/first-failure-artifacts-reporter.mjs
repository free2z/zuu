import {
  retainFirstFailureArtifacts,
  writeRetentionErrors,
} from "./first-failure-artifacts.mjs";

export default class FirstFailureArtifactsReporter {
  constructor() {
    this.retentionErrors = [];
  }

  onBegin(config) {
    this.outputDir = config.projects[0]?.outputDir;
  }

  onTestEnd(test, result) {
    if (result.retry !== 0 || !["failed", "timedOut"].includes(result.status))
      return;
    try {
      retainFirstFailureArtifacts({
        outputDir: this.outputDir,
        test,
        result,
      });
    } catch (error) {
      this.retentionErrors.push({
        test: test.titlePath(),
        status: result.status,
        retry: result.retry,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  onEnd() {
    if (this.retentionErrors.length === 0) return;

    const errors = this.retentionErrors;
    const message = `First-attempt browser diagnostics could not be retained for ${errors.length} result(s): ${errors.map(({ test, error }) => `${test.join(" › ")}: ${error}`).join("; ")}`;
    try {
      writeRetentionErrors({ outputDir: this.outputDir, errors });
    } catch (error) {
      const writeError = error instanceof Error ? error.message : String(error);
      console.error(
        `${message}; also could not write retention-errors.json: ${writeError}`,
      );
      return { status: "failed" };
    }
    console.error(message);
    return { status: "failed" };
  }
}
