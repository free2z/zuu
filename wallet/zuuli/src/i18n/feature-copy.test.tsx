import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Trans } from "react-i18next";
import { createTestI18n } from "./test-provider";
import { MESSAGE_KEYS } from "./messages";
import { translate } from "./translate";
import { localizedError, UiError } from "./errors";
import { ApiError } from "@/lib/api/http";
import { ABOUT_MESSAGES } from "@/lib/about-copy";

describe("shipping feature copy", () => {
  it.each(["en", "es", "fr"] as const)(
    "renders counts and markup through %s ICU",
    (locale) => {
      createTestI18n(locale);
      expect(translate(MESSAGE_KEYS.wordCount, { count: 1 })).not.toEqual(
        translate(MESSAGE_KEYS.wordCount, { count: 2 }),
      );
      const maintenance = translate(MESSAGE_KEYS.maintenanceRemaining, {
        operations: 2,
        stages: 1,
      });
      expect(maintenance).toContain("2");
      expect(maintenance).toContain("1");
      expect(maintenance).not.toMatch(/\{|MESSAGE_KEYS/);
      const warning = renderToStaticMarkup(
        <Trans
          i18nKey={
            MESSAGE_KEYS.featuresWalletOnboardingThisPhraseIsTheOnlyBackupOf
          }
          components={{ part1: <strong /> }}
        />,
      );
      expect(warning).toMatch(/<strong>[^<]+<\/strong>/);
      const username = '<img src=x onerror="secret">';
      const otp = renderToStaticMarkup(
        <Trans
          i18nKey={
            MESSAGE_KEYS.featuresAuthClassicLoginFormEnterThe6DigitCodeFromYour
          }
          components={{ part1: <span>{username}</span> }}
        />,
      );
      expect(otp).not.toContain("<img");
      expect(otp).toContain("&lt;img");
      expect(ABOUT_MESSAGES.pageTitle).toBe(
        translate(MESSAGE_KEYS.libAboutCopyAboutFeedback),
      );
    },
  );
  it.each(["en", "es", "fr"] as const)(
    "maps only structured errors to %s UI",
    (locale) => {
      createTestI18n(locale);
      const privateDetail = "secret token and server traceback";
      for (const error of [
        new Error(privateDetail),
        privateDetail,
        { message: privateDetail },
      ]) {
        expect(localizedError(error)).toBe(
          translate(MESSAGE_KEYS.errorRequest),
        );
        expect(localizedError(error)).not.toContain(privateDetail);
      }
      expect(localizedError(new UiError(MESSAGE_KEYS.errorSignerChanged))).toBe(
        translate(MESSAGE_KEYS.errorSignerChanged),
      );
      expect(
        localizedError(
          new ApiError(401, privateDetail, { detail: privateDetail }),
        ),
      ).toBe(translate(MESSAGE_KEYS.errorSession));
      expect(localizedError(new ApiError(429, privateDetail))).toBe(
        translate(MESSAGE_KEYS.errorRateLimit),
      );
      expect(
        localizedError(new ApiError(500, privateDetail), "local fallback"),
      ).toBe("local fallback");
    },
  );
});
