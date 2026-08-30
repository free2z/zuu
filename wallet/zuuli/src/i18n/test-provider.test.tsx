import { describe, expect, it } from "vitest";
import { createTestI18n } from "./test-provider";

describe("test i18n provider parity", () => {
  it("fails closed on a missing message like production", () => {
    const instance = createTestI18n();
    expect(() => instance.t("missing.test.message")).toThrow(
      "missing i18n message: missing.test.message",
    );
  });

  it("fails closed on malformed ICU like production", () => {
    const instance = createTestI18n("en", {
      broken: "{count, plural, one {one}",
    });
    expect(() => instance.t("broken", { count: 1 })).toThrow(
      /invalid ICU message for broken/,
    );
  });
});
