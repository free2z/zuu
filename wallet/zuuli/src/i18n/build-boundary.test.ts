import { describe, expect, it } from "vitest";
import runtimeSource from "./index.ts?raw";
import { SUPPORTED_LOCALES } from "./locale";
import { MESSAGE_KEYS } from "./messages";

const productionSources = import.meta.glob(
  [
    "../**/*.ts",
    "../**/*.tsx",
    "!../**/*.test.ts",
    "!../**/*.test.tsx",
    "!./messages.ts",
    "!./test-provider.tsx",
  ],
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

describe("locale build boundary", () => {
  it("keeps every production catalog behind an explicit dynamic import", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(runtimeSource).toContain(
        `() => import("./locales/${locale}.json").then((module) => module.default)`,
      );
    }
    expect(runtimeSource).not.toMatch(
      /import\s+\w+\s+from\s+["']\.\/locales\/(?:en|es|fr)\.json["']/,
    );
  });

  it("requires every declared catalog key to have a production consumer", () => {
    for (const property of Object.keys(MESSAGE_KEYS)) {
      expect(
        Object.values(productionSources).some((source) =>
          source.includes(`MESSAGE_KEYS.${property}`),
        ),
        `${property} must be consumed outside tests and the key registry`,
      ).toBe(true);
    }
  });
});
