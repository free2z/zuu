/**
 * The two i18n kernel invariants this surface is held to, enforced against the
 * real source tree rather than against a description of it.
 *
 * ZUULI enforces the same two properties (and a great deal more) from
 * `src/i18n/source-policy.ts` + `build-boundary.test.ts`. That machinery is not
 * copied here: it is 2,300 lines built around ZUULI's own catalog surface, and
 * a copy would rot. What is copied is the pair of guarantees that make the
 * kernel worth having at all.
 *
 *   1. A locale catalog is reachable ONLY through `CATALOG_LOADERS`. One eager
 *      `import en from "./locales/en.json"` anywhere in production source
 *      silently pulls every shipped translation into the entry chunk and
 *      defeats the split — and it does so without failing a single test.
 *   2. Every declared message key has a real consumer. A key nobody reads is a
 *      string three translators maintain forever for nothing.
 *
 * Sources arrive through `import.meta.glob(..., "?raw")` rather than `node:fs`
 * so this file stays a browser-resolvable module: `project-boundary.mjs` builds
 * every source file of this project through a real production Rollup graph, and
 * a Node built-in import would resolve to `__vite-browser-external`.
 */
import { describe, expect, it } from "vitest";
import loaderSource from "./index.ts?raw";
import { SUPPORTED_LOCALES } from "./locale";
import { MESSAGE_KEYS } from "./messages";

/**
 * `test-provider.tsx` is the one production-extension file allowed to import
 * catalogs eagerly: it exists so component tests can assert against real
 * shipped copy, and it is never imported by application code. ZUULI's own
 * boundary carries the same exemption.
 */
const productionSources = import.meta.glob(
  [
    "../**/*.ts",
    "../**/*.tsx",
    "!../**/*.test.ts",
    "!../**/*.test.tsx",
    "!./test-provider.tsx",
  ],
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const nonLoaderSources = Object.entries(productionSources).filter(
  ([, source]) => source !== loaderSource,
);

const LOCALE_REFERENCE = /locales\/([A-Za-z-]+)\.json/g;

describe("locale catalogs are reachable only through CATALOG_LOADERS", () => {
  it("selected the real source tree", () => {
    expect(Object.keys(productionSources).length).toBeGreaterThan(50);
    expect(nonLoaderSources.length).toBe(
      Object.keys(productionSources).length - 1,
    );
  });

  it("names no locale catalog outside the loader registry", () => {
    const offenders: string[] = [];
    for (const [file, source] of nonLoaderSources) {
      for (const match of source.matchAll(LOCALE_REFERENCE)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("loads each shipped locale exactly once, dynamically, from its own file", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(loaderSource).toContain(
        `${locale}: () => import("./locales/${locale}.json").then((module) => module.default),`,
      );
    }
    expect(
      [...loaderSource.matchAll(LOCALE_REFERENCE)].map((match) => match[1]),
    ).toEqual([...SUPPORTED_LOCALES]);
    // The substring assertions above pass whether or not an eager import also
    // exists, so reject that form outright.
    expect(loaderSource).not.toMatch(/^\s*import\s[^\n]*locales\//m);
  });
});

describe("every declared message key has a consumer", () => {
  for (const [accessor, key] of Object.entries(MESSAGE_KEYS)) {
    it(`${key} is read by application code`, () => {
      const pattern = new RegExp(`MESSAGE_KEYS\\.${accessor}(?![A-Za-z0-9_])`);
      const read = nonLoaderSources.some(
        ([file, source]) =>
          !file.endsWith("/messages.ts") && pattern.test(source),
      );
      expect(read).toBe(true);
    });
  }
});
