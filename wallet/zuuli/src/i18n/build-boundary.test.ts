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

const EN_LOADER =
  'en: () => import("./locales/en.json").then((module) => module.default),';

function replaceExact(
  source: string,
  needle: string,
  replacement: string,
): string {
  expect(source.split(needle)).toHaveLength(2);
  return source.replace(needle, replacement);
}

function replaceLoaderRegistryInitializer(replacement: string): string {
  const declaration = runtimeSource.indexOf("export const CATALOG_LOADERS:");
  const objectStart = runtimeSource.indexOf("> = {", declaration) + 4;
  const objectEnd = runtimeSource.indexOf("\n};", objectStart) + 2;
  expect(declaration).toBeGreaterThanOrEqual(0);
  expect(objectStart).toBeGreaterThan(3);
  expect(objectEnd).toBeGreaterThan(objectStart);
  return `${runtimeSource.slice(0, objectStart)}${replacement}${runtimeSource.slice(objectEnd)}`;
}

function expectCatalogPolicyFailure(source: string, diagnostic: string): void {
  let failure: Error | null = null;
  try {
    assertCatalogLoaders(source, SUPPORTED_LOCALES);
  } catch (error) {
    failure = error as Error;
  }
  expect(failure?.message).toBe(diagnostic);
}

const catalogStructureMutants = [
  {
    name: "missing CATALOG_LOADERS declaration",
    mutate: () =>
      replaceExact(
        runtimeSource,
        "export const CATALOG_LOADERS:",
        "export const RENAMED_CATALOG_LOADERS:",
      ),
    diagnostic: "source must declare exactly one CATALOG_LOADERS registry",
  },
  {
    name: "duplicate CATALOG_LOADERS declaration",
    mutate: () => `const CATALOG_LOADERS = {};\n${runtimeSource}`,
    diagnostic: "source must declare exactly one CATALOG_LOADERS registry",
  },
  {
    name: "non-object CATALOG_LOADERS initializer",
    mutate: () => replaceLoaderRegistryInitializer("createLoaders()"),
    diagnostic: "CATALOG_LOADERS must be an object literal",
  },
  {
    name: "spread entry",
    mutate: () =>
      replaceExact(
        runtimeSource,
        "= {\n  en:",
        "= {\n  ...extraLoaders,\n  en:",
      ),
    diagnostic: "CATALOG_LOADERS entries must be property assignments",
  },
  {
    name: "method entry",
    mutate: () =>
      replaceExact(
        runtimeSource,
        EN_LOADER,
        'en() { return import("./locales/en.json").then((module) => module.default); },',
      ),
    diagnostic: "CATALOG_LOADERS entries must be property assignments",
  },
  {
    name: "duplicate locale entry",
    mutate: () =>
      replaceExact(runtimeSource, EN_LOADER, `${EN_LOADER}\n  ${EN_LOADER}`),
    diagnostic: "invalid or duplicate catalog loader: en",
  },
  {
    name: "unsupported locale entry",
    mutate: () =>
      replaceExact(
        runtimeSource,
        EN_LOADER,
        `${EN_LOADER}\n  de: () => import("./locales/de.json").then((module) => module.default),`,
      ),
    diagnostic: "unsupported catalog loader: de",
  },
  {
    name: "wrong locale-to-catalog mapping",
    mutate: () =>
      replaceExact(
        runtimeSource,
        EN_LOADER,
        'en: () => import("./locales/es.json").then((module) => module.default),',
      ),
    diagnostic:
      "catalog loader en must return the dynamic import ./locales/en.json",
  },
  {
    name: "duplicate catalog import inside one loader",
    mutate: () =>
      replaceExact(
        runtimeSource,
        EN_LOADER,
        `en: () => import("./locales/en.json").then((module) => {
    void import("./locales/fr.json");
    return module.default;
  }),`,
      ),
    diagnostic: "catalog loader en must import only ./locales/en.json",
  },
] as const;

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

  it.each(catalogStructureMutants)(
    "kills the $name mutant with its exact diagnostic",
    ({ mutate, diagnostic }) => {
      expectCatalogPolicyFailure(mutate(), diagnostic);
    },
  );

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

  it("kills parse-invalid production source instead of scanning partial syntax", () => {
    let failure: Error | null = null;
    try {
      assertMessageKeyConsumers({ "parse-invalid.ts": "const = ;" }, [
        "commonLoading",
      ]);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toBe(
      "i18n source policy cannot parse parse-invalid.ts",
    );
  });
});
