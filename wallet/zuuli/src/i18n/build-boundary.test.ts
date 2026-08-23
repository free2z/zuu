import { describe, expect, it } from "vitest";
import runtimeSource from "./index.ts?raw";
import { SUPPORTED_LOCALES } from "./locale";
import { MESSAGE_KEYS } from "./messages";
import {
  assertCatalogLoaders,
  assertMessageKeyConsumers,
} from "./source-policy";

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
    expect(() =>
      assertCatalogLoaders(runtimeSource, SUPPORTED_LOCALES),
    ).not.toThrow();
  });

  it("requires every declared catalog key to have a production consumer", () => {
    expect(() =>
      assertMessageKeyConsumers(productionSources, Object.keys(MESSAGE_KEYS)),
    ).not.toThrow();
  });

  it("kills a static catalog-import mutant even when lazy text remains in a comment", () => {
    const mutant = `
      import enCatalog from "./locales/en.json";
      // en: () => import("./locales/en.json")
      ${runtimeSource.replace(
        'en: () => import("./locales/en.json").then((module) => module.default),',
        "en: () => Promise.resolve(enCatalog),",
      )}
    `;
    expect(() => assertCatalogLoaders(mutant, SUPPORTED_LOCALES)).toThrow(
      /must not use a static import/,
    );
  });

  it("kills an eagerly-started dynamic-import mutant", () => {
    const mutant = `
      const eagerEnglish = import("./locales/en.json").then((module) => module.default);
      ${runtimeSource.replace(
        'en: () => import("./locales/en.json").then((module) => module.default),',
        "en: () => eagerEnglish,",
      )}
    `;
    expect(() => assertCatalogLoaders(mutant, SUPPORTED_LOCALES)).toThrow(
      /must return the dynamic import/,
    );
  });

  it("kills an eager prefetch added beside otherwise-valid loaders", () => {
    const mutant = `
      void import("./locales/fr.json");
      ${runtimeSource}
    `;
    expect(() => assertCatalogLoaders(mutant, SUPPORTED_LOCALES)).toThrow(
      /only inside their lazy loaders/,
    );
  });

  it("kills an unreachable lazy-import mutant", () => {
    const mutant = runtimeSource.replace(
      'en: () => import("./locales/en.json").then((module) => module.default),',
      `en: () => {
        return Promise.resolve({});
        import("./locales/en.json").then((module) => module.default);
      },`,
    );
    expect(() => assertCatalogLoaders(mutant, SUPPORTED_LOCALES)).toThrow(
      /must return the dynamic import/,
    );
  });

  it("kills a missing-loader mutant", () => {
    const mutant = runtimeSource.replace(
      'fr: () => import("./locales/fr.json").then((module) => module.default),',
      "",
    );
    expect(() => assertCatalogLoaders(mutant, SUPPORTED_LOCALES)).toThrow(
      /missing catalog loader: fr/,
    );
  });

  it("kills comment-only consumer mutants for every declared key", () => {
    const mutationCounts = new Map<string, number>();
    const mutantSources = Object.fromEntries(
      Object.entries(productionSources).map(([fileName, source]) => {
        let mutant = source;
        for (const property of Object.keys(MESSAGE_KEYS)) {
          const needle = `MESSAGE_KEYS.${property}`;
          const exactConsumer = new RegExp(
            `MESSAGE_KEYS\\.${property}(?![A-Za-z0-9_$])`,
            "g",
          );
          let mutations = 0;
          mutant = mutant.replace(exactConsumer, () => {
            mutations += 1;
            return `undefined /* ${needle} */`;
          });
          mutationCounts.set(
            property,
            (mutationCounts.get(property) ?? 0) + mutations,
          );
        }
        return [fileName, mutant];
      }),
    );

    for (const property of Object.keys(MESSAGE_KEYS)) {
      expect(
        mutationCounts.get(property),
        `${property} must have a real mutation target`,
      ).toBeGreaterThan(0);
    }
    let failure: Error | null = null;
    try {
      assertMessageKeyConsumers(mutantSources, Object.keys(MESSAGE_KEYS));
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).not.toBeNull();
    for (const property of Object.keys(MESSAGE_KEYS)) {
      expect(failure?.message).toContain(property);
    }
  });

  it("does not accept comment or string lookalikes as consumers", () => {
    expect(() =>
      assertMessageKeyConsumers(
        {
          "comment-only.ts": `
            // MESSAGE_KEYS.commonLoading
            const inert = "MESSAGE_KEYS.commonLoading";
            void inert;
          `,
        },
        ["commonLoading"],
      ),
    ).toThrow(/commonLoading/);
  });
});
