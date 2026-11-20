import { beforeEach } from "vitest";
import { createTestI18n } from "../src/i18n/test-provider";

// Route unit tests mount components without the application bootstrap.
createTestI18n();
beforeEach(() => {
  createTestI18n();
});
