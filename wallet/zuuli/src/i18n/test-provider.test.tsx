import { describe, expect, it } from "vitest";
import { MESSAGE_KEYS } from "./messages";
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

  it("resolves the concise recovery copy from each active catalog", () => {
    expect(createTestI18n("en").t(MESSAGE_KEYS.commonTryAgain)).toBe(
      "Try again.",
    );
    expect(createTestI18n("es").t(MESSAGE_KEYS.commonTryAgain)).toBe(
      "Inténtalo de nuevo.",
    );
    expect(createTestI18n("fr").t(MESSAGE_KEYS.commonTryAgain)).toBe(
      "Réessayez.",
    );
  });
});
