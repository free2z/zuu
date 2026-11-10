import { describe, expect, it } from "vitest";
import { MESSAGE_KEYS } from "./messages";
import { assertMessageKeyConsumers } from "./source-policy";
import {
  productionClosure,
  untranslatedLiterals,
  eagerTranslations,
} from "./extraction-policy";
const raw = import.meta.glob(
  ["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx"],
  { eager: true, query: "?raw", import: "default" },
) as Record<string, string>;
const sources = Object.fromEntries(
  Object.entries(raw).map(([name, value]) => [
    name.startsWith("../")
      ? `src/${name.slice(3)}`
      : `src/i18n/${name.slice(2)}`,
    value,
  ]),
);

describe("shipping ZUULI extraction", () => {
  it("audits the current entry and lazy route dependency closure", () => {
    const closure = productionClosure(sources);
    for (const route of ["auth", "home", "wallet", "about"])
      expect(closure).toContain(`src/features/${route}/index.tsx`);
    expect(untranslatedLiterals(sources, closure)).toEqual([]);
    expect(eagerTranslations(sources, closure)).toEqual([]);
    assertMessageKeyConsumers(
      Object.fromEntries(closure.map((file) => [file, sources[file]])),
      Object.keys(MESSAGE_KEYS),
    );
  }, 20_000);
  it.each([
    "<p>New untranslated message</p>",
    'function uiT(value: string) { return value; } const View = () => <p>{uiT("yes")}</p>;',
    'function translate(value: string) { return value; } const View = () => <p>{translate("no")}</p>;',
    'import type { MessageKey } from "./messages"; function text(value: string): MessageKey { return value as MessageKey; } const View = () => <p>{text("New untranslated message")}</p>;',
    '<p>{new Error("New untranslated message").message}</p>',
    '<p>{new String("New untranslated message")}</p>',
    'const error = new Error("New untranslated message"); const View = () => <p>{error.toString()}</p>;',
    '<p>{({ title: "New untranslated message" }).title}</p>',
    'const copy = { message: "New untranslated message" }; const View = () => <p>{copy.message}</p>;',
    'function text() { return ["New untranslated message"].join(" "); } const View = () => <p>{text()}</p>;',
    '<p>{["New untranslated message"].join(" ")}</p>',
    '<p>{translate("New untranslated message")}</p>',
    '<p>{value === "protocol" ? ({ text: "New untranslated message" }).text : null}</p>',
    '<p>{["protocol"].includes(value) ? "New untranslated message" : null}</p>',
    'function text(value: string) { return value; } const View = () => <p>{text("New untranslated message")}</p>',
    "<p>New untranslated message expanded locale</p>",
    '<p>{condition ? "another" : "word"}</p>',
    'function Feature() { toast.error("oops"); }',
    "<p>{error.message}</p>",
    "function Feature() { toast.error(error.message); }",
    '<Input placeholder="New untranslated placeholder" />',
    '<Callout title="New untranslated title" />',
    'function Feature() { const label = "New untranslated label"; return <p>{label}</p>; }',
    'const data = { title: "New untranslated descriptor" };',
    'function Feature() { return toast.error("New untranslated error"); }',
    "function Feature() { return `Found ${count} untranslated results`; }",
  ])("rejects an untranslated mutation: %s", (source) => {
    expect(
      untranslatedLiterals({ "src/features/new.tsx": source }, [
        "src/features/new.tsx",
      ]),
    ).not.toEqual([]);
  });
  it("discovers newly imported lazy routes", () => {
    const mutant = {
      ...sources,
      "src/main.tsx":
        sources["src/main.tsx"] +
        '\nconst newRoute = () => import("./features/new");',
      "src/features/new.tsx":
        "export default () => <p>New untranslated route</p>;",
    };
    expect(untranslatedLiterals(mutant).join("\n")).toContain(
      "New untranslated route",
    );
  });
  it.each([
    [
      "src/lib/about-copy.ts",
      'export const Copy = () => toast.error("New untranslated expanded locale copy");',
    ],
    [
      "src/app-bootstrap.tsx",
      "export const Copy = () => <p>ZUULI locale bootstrap failed</p>",
    ],
    [
      "src/lib/wallet/sensitive-entry.ts",
      'export const Copy = () => toast.error("Secure recovery-phrase entry is unavailable.");',
    ],
  ])(
    "does not exempt a source-only diagnostic/template rendered in %s",
    (file, source) => {
      expect(untranslatedLiterals({ [file]: source }, [file])).not.toEqual([]);
    },
  );
  it("skips only genuinely type-only edges and still discovers value/dynamic imports", () => {
    const entry = "src/main.tsx";
    const types =
      'import type { Type } from "./absent"; import { type Another } from "./absent-two"; export type { T } from "./absent-three"; export { type U } from "./absent-four";';
    expect(productionClosure({ [entry]: types })).toEqual([entry]);
    const sources = {
      [entry]:
        types +
        'import { type Shape, value } from "./live"; import type { Foo } from "./lazy"; const route = () => import("./lazy");',
      "src/live.ts": "export const value = 1;",
      "src/lazy.tsx":
        "export default () => <p>New untranslated lazy route</p>;",
    };
    expect(productionClosure(sources)).toContain("src/live.ts");
    expect(untranslatedLiterals(sources).join("\n")).toContain(
      "New untranslated lazy route",
    );
  });
  it("rejects a module-scope translated default while allowing a deferred getter", () => {
    const prefix = 'import { translate as text } from "@/i18n/translate";';
    const file = "src/features/new.tsx";
    expect(
      eagerTranslations(
        { [file]: prefix + "const empty = <p>{text(key)}</p>;" },
        [file],
      ),
    ).not.toEqual([]);
    expect(
      eagerTranslations(
        {
          [file]:
            prefix + "const labels = { get title() { return text(key); } };",
        },
        [file],
      ),
    ).toEqual([]);
  });
  it("retains exact identifiers and non-rendered diagnostics", () => {
    expect(
      untranslatedLiterals(
        {
          "src/features/new.tsx":
            'const diagnostic = new Error("Technical diagnostic"); export default () => <p>ZEC</p>;',
        },
        ["src/features/new.tsx"],
      ),
    ).toEqual([]);
    expect(
      untranslatedLiterals({ "src/features/new.tsx": "<p>ZEC balance</p>" }, [
        "src/features/new.tsx",
      ]),
    ).not.toEqual([]);
  });
});
