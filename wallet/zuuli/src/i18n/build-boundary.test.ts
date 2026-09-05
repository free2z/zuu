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
    "!./test-provider.tsx",
  ],
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;
const nonLoaderProductionSources = Object.fromEntries(
  Object.entries(productionSources).filter(
    ([, source]) => source !== runtimeSource,
  ),
);

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

function replaceEveryExact(
  source: string,
  needle: string,
  replacement: string,
  expectedCount: number,
): string {
  expect(source.split(needle)).toHaveLength(expectedCount + 1);
  return source.split(needle).join(replacement);
}

function replaceLoaderRegistryInitializer(replacement: string): string {
  const declaration = runtimeSource.indexOf("export const CATALOG_LOADERS:");
  const objectStart =
    runtimeSource.indexOf("> = Object.freeze({", declaration) + 4;
  const objectEnd = runtimeSource.indexOf("\n});", objectStart) + 3;
  expect(declaration).toBeGreaterThanOrEqual(0);
  expect(objectStart).toBeGreaterThan(3);
  expect(objectEnd).toBeGreaterThan(objectStart);
  return `${runtimeSource.slice(0, objectStart)}${replacement}${runtimeSource.slice(objectEnd)}`;
}

function expectCatalogPolicyFailure(
  source: string,
  diagnostic: string,
  otherProductionSources: Readonly<Record<string, string>> = {},
): void {
  let failure: Error | null = null;
  try {
    assertCatalogLoaders(source, SUPPORTED_LOCALES, otherProductionSources);
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
    name: "non-frozen CATALOG_LOADERS initializer",
    mutate: () => replaceLoaderRegistryInitializer("createLoaders()"),
    diagnostic:
      "CATALOG_LOADERS must be one Object.freeze-wrapped object literal",
  },
  {
    name: "bare mutable CATALOG_LOADERS object",
    mutate: () => replaceExact(runtimeSource, "> = Object.freeze({", "> = ({"),
    diagnostic:
      "CATALOG_LOADERS must be one Object.freeze-wrapped object literal",
  },
  {
    name: "spread entry",
    mutate: () =>
      replaceExact(
        runtimeSource,
        "= Object.freeze({\n  en:",
        "= Object.freeze({\n  ...extraLoaders,\n  en:",
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
    name: "computed locale entry",
    mutate: () => replaceExact(runtimeSource, "  en:", "  [locale]:"),
    diagnostic: "invalid or duplicate catalog loader: unknown",
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
  it("includes the production message registry in the eager-import census", () => {
    expect(productionSources["./messages.ts"]).toBeTypeOf("string");
  });

  it("keeps every production catalog behind an explicit dynamic import", () => {
    expect(() =>
      assertCatalogLoaders(
        runtimeSource,
        SUPPORTED_LOCALES,
        nonLoaderProductionSources,
      ),
    ).not.toThrow();
  });

  it.each([
    {
      name: "namespace static import in another module",
      source:
        'import * as catalog from "@/i18n/locales/es.json"; void catalog;',
    },
    {
      name: "dynamic catalog prefetch in another module",
      source: 'void import("../i18n/locales/fr.json");',
    },
    {
      name: "static catalog re-export in another module",
      source: 'export { default as english } from "@/i18n/locales/en.json";',
    },
  ])("kills a $name", ({ source }) => {
    expectCatalogPolicyFailure(
      runtimeSource,
      "catalog import outside loader registry: ../rogue.ts",
      {
        "../rogue.ts": source,
      },
    );
  });

  it("kills an eager catalog import added to the production message registry", () => {
    expectCatalogPolicyFailure(
      runtimeSource,
      "catalog import outside loader registry: ./messages.ts",
      {
        ...nonLoaderProductionSources,
        "./messages.ts": `
          import eagerEnglish from "./locales/en.json";
          void eagerEnglish;
          ${productionSources["./messages.ts"]}
        `,
      },
    );
  });

  it("requires every declared catalog key to have a production consumer", () => {
    expect(() =>
      assertMessageKeyConsumers(productionSources, Object.keys(MESSAGE_KEYS)),
    ).not.toThrow();
  });

  it.each([
    [
      "a local t function",
      (source: string) =>
        replaceExact(
          source,
          "const { t } = useTranslation();",
          'void useTranslation();\n  const t = (_key: string) => "Page not found";',
        ),
    ],
    [
      "an arbitrary object.t function",
      (source: string) =>
        replaceExact(
          source,
          "t(MESSAGE_KEYS.errorNotFoundTitle)",
          '({ t: (_key: string) => "Page not found" }).t(MESSAGE_KEYS.errorNotFoundTitle)',
        ),
    ],
    [
      "a fake useTranslation import",
      (source: string) =>
        replaceExact(source, 'from "react-i18next"', 'from "./fake-i18next"'),
    ],
    [
      "a locally shadowed useTranslation",
      (source: string) =>
        replaceExact(
          source,
          'import { useTranslation } from "react-i18next";',
          'const useTranslation = () => ({ t: (_key: string) => "Page not found" });',
        ),
    ],
    [
      "an arbitrary call result",
      (source: string) =>
        replaceExact(
          source,
          "const { t } = useTranslation();",
          'const fakeHook = () => ({ t: (_key: string) => "Page not found" });\n  const { t } = fakeHook();',
        ),
    ],
    [
      "a non-translator hook result property",
      (source: string) =>
        replaceEveryExact(
          replaceExact(
            source,
            "const { t } = useTranslation();",
            "const translation = useTranslation();",
          ),
          "t(",
          "translation.format(",
          4,
        ),
    ],
    [
      "a renamed non-translator hook result property",
      (source: string) =>
        replaceExact(
          source,
          "const { t } = useTranslation();",
          "const { format: t } = useTranslation();",
        ),
    ],
    [
      "a differently named react-i18next import",
      (source: string) =>
        replaceExact(
          source,
          "{ useTranslation }",
          "{ fakeHook as useTranslation }",
        ),
    ],
    [
      "a reassigned hook binding",
      (source: string) =>
        replaceExact(
          source,
          "const { t } = useTranslation();",
          `let hook = useTranslation;
  hook = (() => ({ t: (_key: string) => "Page not found" })) as unknown as typeof useTranslation;
  const { t } = hook();`,
        ),
    ],
    [
      "a reassigned hook-result alias",
      (source: string) =>
        replaceExact(
          source,
          "const { t } = useTranslation();",
          `let translation = useTranslation();
  translation = { ...translation, t: ((_key: string) => "Page not found") as never };
  const { t } = translation;`,
        ),
    ],
    [
      "a reassigned translator alias",
      (source: string) =>
        replaceEveryExact(
          replaceExact(
            source,
            "const { t } = useTranslation();",
            `let translate = useTranslation().t;
  translate = ((_key: string) => "Page not found") as typeof translate;`,
          ),
          "t(",
          "translate(",
          4,
        ),
    ],
    [
      "a mutated const hook-result property",
      (source: string) =>
        replaceEveryExact(
          replaceExact(
            source,
            "const { t } = useTranslation();",
            `const translation = useTranslation();
  translation.t = ((_key: string) => "Page not found") as never;`,
          ),
          "t(",
          "translation.t(",
          4,
        ),
    ],
    [
      "a mutated computed hook-result property",
      (source: string) =>
        replaceEveryExact(
          replaceExact(
            source,
            "const { t } = useTranslation();",
            `const translation = useTranslation();
  translation["t"] = ((_key: string) => "Page not found") as never;`,
          ),
          "t(",
          'translation["t"](',
          4,
        ),
    ],
    [
      "a hook-result property mutated through a const object alias",
      (source: string) =>
        replaceEveryExact(
          replaceExact(
            source,
            "const { t } = useTranslation();",
            `const translation = useTranslation();
  const alias = translation;
  alias.t = ((_key: string) => "Page not found") as never;`,
          ),
          "t(",
          "translation.t(",
          4,
        ),
    ],
    [
      "a reassigned destructured translator alias",
      (source: string) =>
        replaceEveryExact(
          replaceExact(
            source,
            "const { t } = useTranslation();",
            `let { t: translate } = useTranslation();
  translate = ((_key: string) => "Page not found") as typeof translate;`,
          ),
          "t(",
          "translate(",
          4,
        ),
    ],
    [
      "a hook-result property mutation from a closure",
      (source: string) =>
        replaceEveryExact(
          replaceExact(
            source,
            "const { t } = useTranslation();",
            `const translation = useTranslation();
  const poison = () => {
    translation.t = ((_key: string) => "Page not found") as never;
  };
  poison();`,
          ),
          "t(",
          "translation.t(",
          4,
        ),
    ],
    [
      "a hook-result object escaped to a mutating parameter",
      (source: string) =>
        replaceEveryExact(
          replaceExact(
            source,
            "const { t } = useTranslation();",
            `const translation = useTranslation();
  const poison = (result: { t: unknown }) => {
    result.t = ((_key: string) => "Page not found") as never;
  };
  poison(translation);`,
          ),
          "t(",
          "translation.t(",
          4,
        ),
    ],
  ] as const)(
    "rejects production output translated through %s",
    (_name, mutate) => {
      const fileName = "../components/common/NotFound.tsx";
      const source = productionSources[fileName];
      expect(source).toBeTypeOf("string");
      expect(() =>
        assertMessageKeyConsumers(
          { ...productionSources, [fileName]: mutate(source) },
          Object.keys(MESSAGE_KEYS),
        ),
      ).toThrow(/errorNotFoundTitle/);
    },
  );

  it.each([
    [
      "an aliased named hook import",
      (source: string) =>
        replaceExact(
          replaceExact(
            source,
            "{ useTranslation }",
            "{ useTranslation as useI18n }",
          ),
          "useTranslation()",
          "useI18n()",
        ),
    ],
    [
      "a renamed destructured translator",
      (source: string) =>
        replaceEveryExact(
          replaceExact(
            source,
            "const { t } = useTranslation();",
            "const { t: translate } = useTranslation();",
          ),
          "t(",
          "translate(",
          4,
        ),
    ],
    [
      "a hook result object",
      (source: string) =>
        replaceEveryExact(
          replaceExact(
            source,
            "const { t } = useTranslation();",
            "const translation = useTranslation();",
          ),
          "t(",
          "translation.t(",
          4,
        ),
    ],
    [
      "an aliased hook result object",
      (source: string) =>
        replaceEveryExact(
          replaceExact(
            source,
            "const { t } = useTranslation();",
            "const translation = useTranslation();\n  const alias = translation;\n  const { t: translate } = alias;",
          ),
          "t(",
          "translate(",
          4,
        ),
    ],
    [
      "an aliased hook binding",
      (source: string) =>
        replaceExact(
          source,
          "const { t } = useTranslation();",
          "const hook = useTranslation;\n  const { t } = hook();",
        ),
    ],
    [
      "a namespace hook import",
      (source: string) =>
        replaceExact(
          replaceExact(
            source,
            'import { useTranslation } from "react-i18next";',
            'import * as ReactI18next from "react-i18next";',
          ),
          "useTranslation()",
          "ReactI18next.useTranslation()",
        ),
    ],
    [
      "a translator function alias",
      (source: string) =>
        replaceEveryExact(
          replaceExact(
            source,
            "const { t } = useTranslation();",
            "const translate = useTranslation().t;",
          ),
          "t(",
          "translate(",
          4,
        ),
    ],
    [
      "an element-access hook translator",
      (source: string) =>
        replaceEveryExact(
          replaceExact(
            source,
            "const { t } = useTranslation();",
            "const translation = useTranslation();",
          ),
          "t(",
          'translation["t"](',
          4,
        ),
    ],
  ] as const)("accepts production translations through %s", (_name, mutate) => {
    const fileName = "../components/common/NotFound.tsx";
    const source = productionSources[fileName];
    expect(source).toBeTypeOf("string");
    expect(() =>
      assertMessageKeyConsumers(
        { ...productionSources, [fileName]: mutate(source) },
        Object.keys(MESSAGE_KEYS),
      ),
    ).not.toThrow();
  });

  it.each([
    ["a decorative key read", "void MESSAGE_KEYS.navOpenWallet;"],
    [
      "a discarded translation call",
      "void t(MESSAGE_KEYS.navOpenWallet);",
    ],
  ])(
    "rejects a hardcoded TopBar label hidden by %s",
    (_name, decoration) => {
      const fileName = "../components/layout/TopBar.tsx";
      const topBar = productionSources[fileName];
      expect(topBar).toBeTypeOf("string");
      let mutant = replaceExact(
        topBar,
        "aria-label={t(MESSAGE_KEYS.navOpenWallet)}",
        'aria-label="Open wallet"',
      );
      mutant = replaceExact(
        mutant,
        "export function TopBar() {",
        `export function TopBar() {\n  ${decoration}`,
      );
      expect(() =>
        assertMessageKeyConsumers(
          { ...productionSources, [fileName]: mutant },
          Object.keys(MESSAGE_KEYS),
        ),
      ).toThrow(/navOpenWallet/);
    },
  );

  it("rejects a translated attribute that a later JSX spread can override", () => {
    expect(() =>
      assertMessageKeyConsumers(
        {
          "spread-override.tsx": `
            import { MESSAGE_KEYS } from "@/i18n/messages";
            import { useTranslation } from "react-i18next";
            const hardcoded = { placeholder: "Buscar creadores y páginas…" };
            export function Search() {
              const { t } = useTranslation();
              return <input placeholder={t(MESSAGE_KEYS.navSearchPlaceholder)} {...hardcoded} />;
            }
          `,
        },
        ["navSearchPlaceholder"],
      ),
    ).toThrow(/navSearchPlaceholder/);
  });

  it("allows a translated attribute to override an earlier JSX spread", () => {
    expect(() =>
      assertMessageKeyConsumers(
        {
          "spread-before.tsx": `
            import { MESSAGE_KEYS } from "@/i18n/messages";
            import { useTranslation } from "react-i18next";
            const defaults = { placeholder: "fallback" };
            export function Search() {
              const { t } = useTranslation();
              return <input {...defaults} placeholder={t(MESSAGE_KEYS.navSearchPlaceholder)} />;
            }
          `,
        },
        ["navSearchPlaceholder"],
      ),
    ).not.toThrow();
  });

  it.each([
    [
      "a discarded comma operand",
      '(t(MESSAGE_KEYS.errorNotFoundTitle), "Page not found")',
    ],
    [
      "a truthiness-only left operand",
      't(MESSAGE_KEYS.errorNotFoundTitle) && "Page not found"',
    ],
    [
      "a condition-only translation",
      't(MESSAGE_KEYS.errorNotFoundTitle) ? "Page not found" : "Page not found"',
    ],
    [
      "a discarding call",
      '((_translated: string) => "Page not found")(t(MESSAGE_KEYS.errorNotFoundTitle))',
    ],
    [
      "a statically truthy OR left operand",
      '"Page not found" || t(MESSAGE_KEYS.errorNotFoundTitle)',
    ],
    [
      "a statically falsy AND left operand",
      '"" && t(MESSAGE_KEYS.errorNotFoundTitle)',
    ],
    [
      "a statically non-nullish left operand",
      '"Page not found" ?? t(MESSAGE_KEYS.errorNotFoundTitle)',
    ],
  ] as const)(
    "rejects a hardcoded NotFound title hidden behind %s",
    (_name, replacement) => {
      const fileName = "../components/common/NotFound.tsx";
      const source = productionSources[fileName];
      expect(source).toBeTypeOf("string");
      const mutant = replaceExact(
        source,
        "t(MESSAGE_KEYS.errorNotFoundTitle)",
        replacement,
      );
      expect(() =>
        assertMessageKeyConsumers(
          { ...productionSources, [fileName]: mutant },
          Object.keys(MESSAGE_KEYS),
        ),
      ).toThrow(/errorNotFoundTitle/);
    },
  );

  it.each([
    "`${t(MESSAGE_KEYS.errorNotFoundTitle)}`",
    '"" + t(MESSAGE_KEYS.errorNotFoundTitle)',
    'true ? t(MESSAGE_KEYS.errorNotFoundTitle) : "fallback"',
    "false || t(MESSAGE_KEYS.errorNotFoundTitle)",
    "true && t(MESSAGE_KEYS.errorNotFoundTitle)",
    't(MESSAGE_KEYS.errorNotFoundTitle) || "fallback"',
    't(MESSAGE_KEYS.errorNotFoundTitle) ?? "fallback"',
    "null ?? t(MESSAGE_KEYS.errorNotFoundTitle)",
    "(0, t(MESSAGE_KEYS.errorNotFoundTitle))",
  ])("accepts a translated NotFound title through %s", (replacement) => {
    const fileName = "../components/common/NotFound.tsx";
    const source = productionSources[fileName];
    expect(source).toBeTypeOf("string");
    const passThrough = replaceExact(
      source,
      "t(MESSAGE_KEYS.errorNotFoundTitle)",
      replacement,
    );
    expect(() =>
      assertMessageKeyConsumers(
        { ...productionSources, [fileName]: passThrough },
        Object.keys(MESSAGE_KEYS),
      ),
    ).not.toThrow();
  });

  it("rejects a translation passed to a locally declared component sink", () => {
    expect(() =>
      assertMessageKeyConsumers(
        {
          "discarded-component-prop.tsx": `
            import { MESSAGE_KEYS } from "@/i18n/messages";
            import { useTranslation } from "react-i18next";
            function DiscardedTranslation({ translated: _translated }) {
              return <span>Retry</span>;
            }
            export function Error() {
              const { t } = useTranslation();
              return <DiscardedTranslation translated={t(MESSAGE_KEYS.commonRetry)} />;
            }
          `,
        },
        ["commonRetry"],
      ),
    ).toThrow(/commonRetry/);
  });

  it("rejects a translation passed through a member-tag local sink", () => {
    expect(() =>
      assertMessageKeyConsumers(
        {
          "member-component-prop.tsx": `
            import { MESSAGE_KEYS } from "@/i18n/messages";
            import { useTranslation } from "react-i18next";
            function DiscardedTranslation({ translated: _translated }) {
              return <span>Retry</span>;
            }
            const Local = { DiscardedTranslation };
            export function Error() {
              const { t } = useTranslation();
              return <Local.DiscardedTranslation translated={t(MESSAGE_KEYS.commonRetry)} />;
            }
          `,
        },
        ["commonRetry"],
      ),
    ).toThrow(/commonRetry/);
  });

  it("rejects an arbitrary imported component prop as a translation sink", () => {
    expect(() =>
      assertMessageKeyConsumers(
        {
          "imported-component-prop.tsx": `
            import { DiscardedTranslation } from "./discarded-translation";
            import { MESSAGE_KEYS } from "@/i18n/messages";
            import { useTranslation } from "react-i18next";
            export function Error() {
              const { t } = useTranslation();
              return <DiscardedTranslation translated={t(MESSAGE_KEYS.commonRetry)} />;
            }
          `,
        },
        ["commonRetry"],
      ),
    ).toThrow(/commonRetry/);
  });

  it("rejects discarded translated component children", () => {
    expect(() =>
      assertMessageKeyConsumers(
        {
          "discarded-component-child.tsx": `
            import { DiscardedTranslation } from "./discarded-translation";
            import { MESSAGE_KEYS } from "@/i18n/messages";
            import { useTranslation } from "react-i18next";
            export function Error() {
              const { t } = useTranslation();
              return <DiscardedTranslation>{t(MESSAGE_KEYS.commonRetry)}</DiscardedTranslation>;
            }
          `,
        },
        ["commonRetry"],
      ),
    ).toThrow(/commonRetry/);
  });

  it("rejects nested translated JSX passed through a discarded prop", () => {
    expect(() =>
      assertMessageKeyConsumers(
        {
          "discarded-nested-jsx.tsx": `
            import { DiscardedTranslation } from "./discarded-translation";
            import { MESSAGE_KEYS } from "@/i18n/messages";
            import { useTranslation } from "react-i18next";
            export function Error() {
              const { t } = useTranslation();
              return <DiscardedTranslation content={<span>{t(MESSAGE_KEYS.commonRetry)}</span>} />;
            }
          `,
        },
        ["commonRetry"],
      ),
    ).toThrow(/commonRetry/);
  });

  it("rejects a translation hidden in a statically dead JSX branch", () => {
    expect(() =>
      assertMessageKeyConsumers(
        {
          "dead-translation.tsx": `
            import { MESSAGE_KEYS } from "@/i18n/messages";
            import { useTranslation } from "react-i18next";
            export function Error() {
              const { t } = useTranslation();
              return <span>{false && t(MESSAGE_KEYS.commonRetry)}</span>;
            }
          `,
        },
        ["commonRetry"],
      ),
    ).toThrow(/commonRetry/);
  });

  it("accepts a local component prop proven to reach an intrinsic element", () => {
    expect(() =>
      assertMessageKeyConsumers(
        {
          "rendered-local-component.tsx": `
            import { MESSAGE_KEYS } from "@/i18n/messages";
            import { useTranslation } from "react-i18next";
            function RenderedTranslation({ translated }) {
              return <span>{translated}</span>;
            }
            export function Error() {
              const { t } = useTranslation();
              return <RenderedTranslation translated={t(MESSAGE_KEYS.commonRetry)} />;
            }
          `,
        },
        ["commonRetry"],
      ),
    ).not.toThrow();
  });

  it("rejects a local component prop discarded before its intrinsic sink", () => {
    expect(() =>
      assertMessageKeyConsumers(
        {
          "discarded-local-output.tsx": `
            import { MESSAGE_KEYS } from "@/i18n/messages";
            import { useTranslation } from "react-i18next";
            function DiscardedTranslation({ translated }) {
              return <span>{(translated, "Retry")}</span>;
            }
            export function Error() {
              const { t } = useTranslation();
              return <DiscardedTranslation translated={t(MESSAGE_KEYS.commonRetry)} />;
            }
          `,
        },
        ["commonRetry"],
      ),
    ).toThrow(/commonRetry/);
  });

  it("rejects translated nested JSX discarded by its reviewed parent", () => {
    expect(() =>
      assertMessageKeyConsumers(
        {
          "discarded-nested-output.tsx": `
            import { MESSAGE_KEYS } from "@/i18n/messages";
            import { useTranslation } from "react-i18next";
            export function Error() {
              const { t } = useTranslation();
              return <div>{(<span>{t(MESSAGE_KEYS.commonRetry)}</span>, <span>Retry</span>)}</div>;
            }
          `,
        },
        ["commonRetry"],
      ),
    ).toThrow(/commonRetry/);
  });

  it("accepts only the reviewed prop on an exact imported sink identity", () => {
    expect(() =>
      assertMessageKeyConsumers(
        {
          "reviewed-import.tsx": `
            import { EmptyState as Result } from "@/components/common/EmptyState";
            import { MESSAGE_KEYS } from "@/i18n/messages";
            import { useTranslation } from "react-i18next";
            export function Error() {
              const { t } = useTranslation();
              return <Result title={t(MESSAGE_KEYS.commonRetry)} description="Fallback" />;
            }
          `,
        },
        ["commonRetry"],
      ),
    ).not.toThrow();
    expect(() =>
      assertMessageKeyConsumers(
        {
          "unreviewed-import-prop.tsx": `
            import { EmptyState as Result } from "@/components/common/EmptyState";
            import { MESSAGE_KEYS } from "@/i18n/messages";
            import { useTranslation } from "react-i18next";
            export function Error() {
              const { t } = useTranslation();
              return <Result data-decoration={t(MESSAGE_KEYS.commonRetry)} title="Fallback" />;
            }
          `,
        },
        ["commonRetry"],
      ),
    ).toThrow(/commonRetry/);
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
      /must not use a static import or re-export/,
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

  it("does not accept a shadowed MESSAGE_KEYS lookalike as a consumer", () => {
    expect(() =>
      assertMessageKeyConsumers(
        {
          "shadowed.tsx": `
            import { MESSAGE_KEYS } from "@/i18n/messages";
            function Shadowed() {
              const MESSAGE_KEYS = { commonLoading: "hardcoded" };
              return <span>{t(MESSAGE_KEYS.commonLoading)}</span>;
            }
            void Shadowed;
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
