import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import walletComponents from "@/features/wallet/components.tsx?raw";
import historySource from "@/features/wallet/History.tsx?raw";
import receiveSource from "@/features/wallet/Receive.tsx?raw";
import sendSource from "@/features/wallet/Send.tsx?raw";
import loginSource from "@/features/auth/ZcashLoginFlow.tsx?raw";
import { BidiIdentifier } from "./BidiIdentifier";
import {
  assertBidiIdentifierPolicy,
  type BidiProductionSources,
} from "./bidi-identifier-policy";

const FULL =
  "u1guard7c9a0b1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2tail987654";

const FILES = [
  "src/features/wallet/components.tsx",
  "src/features/wallet/History.tsx",
  "src/features/wallet/Receive.tsx",
  "src/features/wallet/Send.tsx",
  "src/features/auth/ZcashLoginFlow.tsx",
] as const;

function productionSources(): BidiProductionSources {
  return {
    "src/features/wallet/components.tsx": walletComponents,
    "src/features/wallet/History.tsx": historySource,
    "src/features/wallet/Receive.tsx": receiveSource,
    "src/features/wallet/Send.tsx": sendSource,
    "src/features/auth/ZcashLoginFlow.tsx": loginSource,
  };
}

function mutate(
  sources: BidiProductionSources,
  file: (typeof FILES)[number],
  before: string,
  after: string,
): BidiProductionSources {
  const original = sources[file];
  const changed = original.replace(before, after);
  expect(changed, `mutation did not apply to ${file}`).not.toBe(original);
  return { ...sources, [file]: changed };
}

function parsedSource(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function insertAfterBidiValue(
  sources: BidiProductionSources,
  fileName: (typeof FILES)[number],
  valueText: string,
  insertion: string,
): BidiProductionSources {
  const source = sources[fileName];
  const file = parsedSource(fileName, source);
  const matches: ts.JsxSelfClosingElement[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxSelfClosingElement(node) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === "BidiIdentifier" &&
      node.attributes.properties.some(
        (property) =>
          ts.isJsxAttribute(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "value" &&
          property.initializer &&
          ts.isJsxExpression(property.initializer) &&
          property.initializer.expression?.getText(file) === valueText,
      )
    ) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(matches, `unique ${fileName} BidiIdentifier value=${valueText}`).toHaveLength(1);
  const position = matches[0].end;
  return {
    ...sources,
    [fileName]: `${source.slice(0, position)}${insertion}${source.slice(position)}`,
  };
}

function insertIntoFunction(
  sources: BidiProductionSources,
  fileName: (typeof FILES)[number],
  functionName: string,
  insertion: string,
): BidiProductionSources {
  const source = sources[fileName];
  const file = parsedSource(fileName, source);
  const matches: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === functionName &&
      node.body
    ) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(matches, `unique function ${functionName} in ${fileName}`).toHaveLength(1);
  const position = matches[0].body!.getStart(file) + 1;
  return {
    ...sources,
    [fileName]: `${source.slice(0, position)}${insertion}${source.slice(position)}`,
  };
}

describe("BidiIdentifier", () => {
  it("owns the full title and LTR boundary while shortening only visible text", () => {
    const html = renderToStaticMarkup(
      <BidiIdentifier value={FULL} shorten className="mono-id" />,
    );
    expect(html).toBe(
      `<bdi class="mono-id" dir="ltr" title="${FULL}">u1guard7…tail987654</bdi>`,
    );
  });

  it("keeps an unshortened identifier byte-for-byte inside the same boundary", () => {
    expect(renderToStaticMarkup(<BidiIdentifier value="meeting-42-Z" />)).toBe(
      '<bdi dir="ltr" title="meeting-42-Z">meeting-42-Z</bdi>',
    );
  });
});

// These are compiler-backed source-policy tests, not ordinary unit assertions.
// Keep their budget local to this suite so a saturated parallel worker cannot
// turn legitimate AST analysis into a global retry or timeout increase.
describe("opaque identifier production inventory", { timeout: 30_000 }, () => {
  it("binds all 13 wallet/auth displays, both live IDs, and both editable addresses", () => {
    expect(() => assertBidiIdentifierPolicy(productionSources())).not.toThrow();
  });

  it("rejects a direct truncation bypass even when a comment advertises the component", () => {
    const sources = productionSources();
    const mutant = mutate(
      sources,
      "src/features/wallet/components.tsx",
      `<BidiIdentifier\n          value={address}\n          shorten\n          className="mono-id block break-all font-mono text-sm text-foreground"\n        />`,
      `<span>{truncateAddress(address)}</span>\n        {/* <BidiIdentifier value={address} shorten /> */}`,
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow();
  });

  it.each([
    {
      name: "raw unified address",
      file: "src/features/wallet/Receive.tsx" as const,
      before: `<BidiIdentifier\n                value={address}\n                className="mono-id block break-all rounded-lg border border-border bg-background/40 p-3 font-mono text-xs text-foreground"\n              />`,
      after: `<span>{address}</span>`,
    },
    {
      name: "raw payment recipient",
      file: "src/features/wallet/Send.tsx" as const,
      before: `<BidiIdentifier\n                    value={proposal.review.payments[0]?.recipient ?? ""}\n                    className="mono-id min-w-0 break-all text-end font-mono text-xs"\n                    data-testid="send-review-recipient"\n                  />`,
      after: `<span>{proposal.review.payments[0]?.recipient ?? ""}</span>`,
    },
    {
      name: "raw transaction ID",
      file: "src/features/wallet/History.tsx" as const,
      before: `<BidiIdentifier\n            value={tx.txid}\n            shorten\n            className="mono-id font-mono text-xs text-muted-foreground/70"\n          />`,
      after: `<span>{tx.txid}</span>`,
    },
    {
      name: "toast string",
      file: "src/features/wallet/Send.tsx" as const,
      before: `<BidiIdentifier value={result.txid} shorten />`,
      after: `{result.txid}`,
    },
  ])("rejects the $name bypass", ({ file, before, after }) => {
    const mutant = mutate(productionSources(), file, before, after);
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow();
  });

  /**
   * The DID alias-laundering mutant used to live on the profile surface, which
   * #904 phase 4 removed. Re-hosted on the transaction id: same defect shape —
   * an executable alias standing between the audited value and the audited
   * render site.
   */
  it("rejects laundering an audited identifier through an executable alias", () => {
    let mutant = mutate(
      productionSources(),
      "src/features/wallet/History.tsx",
      "function HistoryRow({ tx }: { tx: TransactionEntry }) {\n  const incoming = tx.incoming;",
      "function HistoryRow({ tx }: { tx: TransactionEntry }) {\n  const incoming = tx.incoming;\n  const displayAlias = tx.txid;",
    );
    mutant = mutate(
      mutant,
      "src/features/wallet/History.tsx",
      "            value={tx.txid}\n            shorten",
      "            value={displayAlias}\n            shorten",
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow();
  });

  it("binds an audited BidiIdentifier site to the imported component symbol", () => {
    const mutant = mutate(
      productionSources(),
      "src/features/wallet/Receive.tsx",
      "export function Receive() {",
      "export function Receive() {\n  const BidiIdentifier = ({ value }: { value: string }) => <span>{value}</span>;",
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(/bidi sites changed/);
  });

  it("rejects an additional raw display of an audited identifier value", () => {
    const mutant = mutate(
      productionSources(),
      "src/features/wallet/Receive.tsx",
      `              <CopyButton
                value={address}`,
      `              <span>{address}</span>
              <CopyButton
                value={address}`,
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it("rejects the reviewed AddressCard template-interpolation survivor", () => {
    const mutant = mutate(
      productionSources(),
      "src/features/wallet/components.tsx",
      `        />
        <div className="pt-1">`,
      [
        "        />",
        '        <span>{`${address}`}</span>',
        '        <div className="pt-1">',
      ].join("\n"),
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it.each([
    ["template interpolation", "`${address}`"],
    ["global String conversion", "String(address)"],
    ["toString conversion", "address.toString()"],
    ["slice conversion", "address.slice(0, 8)"],
    ["substring conversion", "address.substring(0, 8)"],
    ["replace conversion", 'address.replace(/^u/, "z")'],
    ["lowercase conversion", "address.toLowerCase()"],
    ["split/join conversion", 'address.split("").join("")'],
    ["chained collection conversion", 'address.split("").reverse().join("")'],
    ["spread/join conversion", '[...address].join("")'],
    ["element access", "address[0]"],
    ["logical-and wrapper", "true && address"],
    ["conditional wrapper", 'true ? address : "unavailable"'],
    ["nullish wrapper", 'address ?? "unavailable"'],
  ])("rejects an additional raw display through %s", (_name, expression) => {
    const mutant = mutate(
      productionSources(),
      "src/features/wallet/Receive.tsx",
      `              <CopyButton
                value={address}`,
      `              <span>{${expression}}</span>
              <CopyButton
                value={address}`,
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it.each([
    ["title", '<span title={address}>Address</span>'],
    ["accessible label", '<span aria-label={address}>Address</span>'],
  ])("rejects an audited identifier in the %s attribute", (_name, element) => {
    const mutant = mutate(
      productionSources(),
      "src/features/wallet/Receive.tsx",
      `              <CopyButton
                value={address}`,
      `${element}
              <CopyButton
                value={address}`,
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it("rejects an audited identifier in an arbitrary component display prop", () => {
    let mutant = mutate(
      productionSources(),
      "src/features/wallet/Receive.tsx",
      "export function Receive() {",
      [
        "function AddressBadge({ displayText }: { displayText: string }) {",
        "  return <span>{displayText}</span>;",
        "}",
        "",
        "export function Receive() {",
      ].join("\n"),
    );
    mutant = mutate(
      mutant,
      "src/features/wallet/Receive.tsx",
      `              <CopyButton
                value={address}`,
      `<AddressBadge displayText={address} />
              <CopyButton
                value={address}`,
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it.each([
    ["property assignment", "{ title: address }"],
    ["shorthand property", "{ address }"],
    ["nested spread", "{ ...{ title: address } }"],
  ])("rejects an audited identifier in spread JSX %s", (_name, props) => {
    const mutant = mutate(
      productionSources(),
      "src/features/wallet/Receive.tsx",
      `              <CopyButton
                value={address}`,
      `<span {...${props}}>Address</span>
              <CopyButton
                value={address}`,
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it("does not authorize a local lookalike of an allowed non-text sink", () => {
    let mutant = mutate(
      productionSources(),
      "src/features/wallet/Receive.tsx",
      "export function Receive() {",
      [
        "function Receive() {",
        "  const QRCodeSVG = ({ value }: { value: string }) => <span>{value}</span>;",
      ].join("\n"),
    );
    mutant = mutate(
      mutant,
      "src/features/wallet/Receive.tsx",
      `              <CopyButton
                value={address}`,
      `<QRCodeSVG value={address} />
              <CopyButton
                value={address}`,
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it("rejects an audited identifier passed through an arbitrary display helper", () => {
    let mutant = mutate(
      productionSources(),
      "src/features/wallet/Receive.tsx",
      "  const address = useWallet((s) => s.unifiedAddress);",
      [
        "  const address = useWallet((s) => s.unifiedAddress);",
        "  const displayAddress = (value: string) => value.slice(0, 8);",
      ].join("\n"),
    );
    mutant = mutate(
      mutant,
      "src/features/wallet/Receive.tsx",
      `              <CopyButton
                value={address}`,
      `              <span>{displayAddress(address)}</span>
              <CopyButton
                value={address}`,
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it("rejects a lexically aliased raw identifier display", () => {
    let mutant = mutate(
      productionSources(),
      "src/features/wallet/Receive.tsx",
      "  const address = useWallet((s) => s.unifiedAddress);",
      "  const address = useWallet((s) => s.unifiedAddress);\n  const rawAlias = address;",
    );
    mutant = mutate(
      mutant,
      "src/features/wallet/Receive.tsx",
      `              <CopyButton
                value={address}`,
      `              <span>{rawAlias}</span>
              <CopyButton
                value={address}`,
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it("rejects bracket notation for an audited dotted transaction ID", () => {
    const mutant = insertAfterBidiValue(
      productionSources(),
      "src/features/wallet/History.tsx",
      "tx.txid",
      '<span>{tx["txid"]}</span>',
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it("rejects a destructured alias of an audited transaction ID", () => {
    let mutant = insertIntoFunction(
      productionSources(),
      "src/features/wallet/History.tsx",
      "HistoryRow",
      "\n  const { txid: leakedTxid } = tx;",
    );
    mutant = insertAfterBidiValue(
      mutant,
      "src/features/wallet/History.tsx",
      "tx.txid",
      "<span>{leakedTxid}</span>",
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it("rejects a statically computed property for an audited transaction ID", () => {
    let mutant = insertIntoFunction(
      productionSources(),
      "src/features/wallet/History.tsx",
      "HistoryRow",
      '\n  const identifierProperty: "txid" = "txid";',
    );
    mutant = insertAfterBidiValue(
      mutant,
      "src/features/wallet/History.tsx",
      "tx.txid",
      "<span>{tx[identifierProperty]}</span>",
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it("rejects an audited member reached through an aliased base", () => {
    let mutant = insertIntoFunction(
      productionSources(),
      "src/features/wallet/History.tsx",
      "HistoryRow",
      "\n  const leakedTransaction = tx;",
    );
    mutant = insertAfterBidiValue(
      mutant,
      "src/features/wallet/History.tsx",
      "tx.txid",
      "<span>{leakedTransaction.txid}</span>",
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it("rejects destructuring an audited member from an aliased object literal", () => {
    let mutant = insertIntoFunction(
      productionSources(),
      "src/features/wallet/History.tsx",
      "HistoryRow",
      [
        "\n  const wrappedIdentifier = { leakedTxid: tx.txid };",
        "  const { leakedTxid } = wrappedIdentifier;",
      ].join("\n"),
    );
    mutant = insertAfterBidiValue(
      mutant,
      "src/features/wallet/History.tsx",
      "tx.txid",
      "<span>{leakedTxid}</span>",
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it.each([
    ["an array destructure", "\n  const [reviewLeak] = [tx.txid];", "reviewLeak"],
    [
      "a nested object destructure",
      "\n  const reviewWrapper = { nested: { leakedTxid: tx.txid } };\n  const { nested: { leakedTxid: reviewLeak } } = reviewWrapper;",
      "reviewLeak",
    ],
    [
      "a computed-key destructure",
      '\n  const reviewKey: "leakedTxid" = "leakedTxid";\n  const reviewWrapper = { leakedTxid: tx.txid };\n  const { [reviewKey]: reviewLeak } = reviewWrapper;',
      "reviewLeak",
    ],
    [
      "a selected object-literal property",
      "\n  const reviewWrapper = { leakedTxid: tx.txid };",
      "reviewWrapper.leakedTxid",
    ],
    [
      "a nested selected object-literal property",
      "\n  const reviewWrapper = { nested: { leakedTxid: tx.txid } };",
      "reviewWrapper.nested.leakedTxid",
    ],
    [
      "a computed selected object-literal property",
      '\n  const reviewKey: "leakedTxid" = "leakedTxid";\n  const reviewWrapper = { leakedTxid: tx.txid };',
      "reviewWrapper[reviewKey]",
    ],
    [
      "a selected array element",
      '\n  const reviewValues = ["decorative", tx.txid];',
      "reviewValues[1]",
    ],
    [
      "a zero-argument local closure",
      "\n  const reviewLeak = () => tx.txid;",
      "reviewLeak()",
    ],
    [
      "an aliased zero-argument local closure",
      "\n  const reviewSource = () => tx.txid;\n  const reviewLeak = reviewSource;",
      "reviewLeak()",
    ],
    [
      "an object-held zero-argument local closure",
      "\n  const reviewLeaks = { selected: () => tx.txid };",
      "reviewLeaks.selected()",
    ],
    [
      "an object-destructured zero-argument local closure",
      "\n  const { selected: reviewLeak } = { selected: () => tx.txid };",
      "reviewLeak()",
    ],
    [
      "an array-held zero-argument local closure",
      "\n  const reviewLeaks = [() => tx.txid];",
      "reviewLeaks[0]()",
    ],
    [
      "an array-destructured zero-argument local closure",
      "\n  const [reviewLeak] = [() => tx.txid];",
      "reviewLeak()",
    ],
    [
      "a bound zero-argument local closure",
      "\n  const reviewLeak = (() => tx.txid).bind(null);",
      "reviewLeak()",
    ],
    [
      "a zero-argument local closure factory",
      "\n  const reviewFactory = () => () => tx.txid;\n  const reviewLeak = reviewFactory();",
      "reviewLeak()",
    ],
    [
      "a conditional zero-argument local closure",
      "\n  const reviewLeak = tx.confirmed ? () => tx.txid : () => \"decorative\";",
      "reviewLeak()",
    ],
    [
      "a zero-argument closure optional-parameter fallback",
      "\n  const reviewLeak = (value?: string) => value ?? tx.txid;",
      "reviewLeak()",
    ],
    [
      "a zero-argument closure rest-destructuring default",
      "\n  const reviewLeak = (...[value = tx.txid]: string[]) => value;",
      "reviewLeak()",
    ],
    [
      "a zero-argument closure default parameter",
      "\n  const reviewLeak = (value = tx.txid, ..._rest: string[]) => value;",
      "reviewLeak()",
    ],
    [
      "a zero-argument closure object-valued default parameter",
      "\n  const reviewLeak = (value = { leakedTxid: tx.txid }) => value.leakedTxid;",
      "reviewLeak()",
    ],
    [
      "a zero-argument closure array-valued default parameter",
      "\n  const reviewLeak = (values = [tx.txid]) => values[0];",
      "reviewLeak()",
    ],
    [
      "a zero-argument closure object-destructuring default",
      "\n  const reviewLeak = ({ leakedTxid = tx.txid } = {}) => leakedTxid;",
      "reviewLeak()",
    ],
    [
      "a zero-argument closure array-destructuring default",
      "\n  const reviewLeak = ([leakedTxid = tx.txid] = []) => leakedTxid;",
      "reviewLeak()",
    ],
    [
      "a zero-argument closure object-parameter source",
      "\n  const reviewLeak = ({ leakedTxid } = { leakedTxid: tx.txid }) => leakedTxid;",
      "reviewLeak()",
    ],
    [
      "a zero-argument closure array-parameter source",
      "\n  const reviewLeak = ([leakedTxid] = [tx.txid]) => leakedTxid;",
      "reviewLeak()",
    ],
    [
      "an array-rest destructure",
      '\n  const [, ...reviewLeaks] = ["decorative", tx.txid];',
      "reviewLeaks[0]",
    ],
    [
      "an object-rest destructure",
      '\n  const { decorative, ...reviewLeaks } = { decorative: "label", leakedTxid: tx.txid };\n  void decorative;',
      "reviewLeaks.leakedTxid",
    ],
    [
      "an object-destructuring default",
      "\n  const { leakedTxid: reviewLeak = tx.txid } = {};",
      "reviewLeak",
    ],
    [
      "an array-destructuring default",
      "\n  const [reviewLeak = tx.txid] = [];",
      "reviewLeak",
    ],
    ["a zero-argument IIFE", "", "(() => tx.txid)()"],
    ["a sequence expression", "", "(0, tx.txid)"],
  ] as const)("rejects an audited transaction ID through %s", (_, setup, display) => {
    let mutant = productionSources();
    if (setup) {
      mutant = insertIntoFunction(
        mutant,
        "src/features/wallet/History.tsx",
        "HistoryRow",
        setup,
      );
    }
    mutant = insertAfterBidiValue(
      mutant,
      "src/features/wallet/History.tsx",
      "tx.txid",
      `<span>{${display}}</span>`,
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(
      /renders audited identifier values outside imported BidiIdentifier/,
    );
  });

  it("allows equivalent member shapes that do not derive from the audited source", () => {
    let mutant = insertIntoFunction(
      productionSources(),
      "src/features/wallet/History.tsx",
      "HistoryRow",
      [
        '\n  const unrelatedProperty: "txid" = "txid";',
        '  const unrelatedTransaction = { txid: "decorative" };',
        '  const safeWrapper = { safeLeak: "decorative" };',
        "  const { safeLeak } = safeWrapper;",
        '  const [safeArrayLeak] = ["decorative"];',
        '  const nestedSafeWrapper = { nested: { safeLeak: "decorative" } };',
        "  const { nested: { safeLeak: nestedSafeLeak } } = nestedSafeWrapper;",
        '  const safeKey: "safeLeak" = "safeLeak";',
        "  const { [safeKey]: computedSafeLeak } = safeWrapper;",
        '  const safeClosure = () => "decorative";',
        "  const safeClosureAlias = safeClosure;",
        "  const safeClosureObject = { selected: safeClosure };",
        "  const { selected: safeDestructuredObjectClosure } = safeClosureObject;",
        "  const safeClosureArray = [safeClosure];",
        "  const [safeDestructuredArrayClosure] = safeClosureArray;",
        "  const safeBoundClosure = safeClosure.bind(null);",
        "  const safeClosureFactory = () => safeClosure;",
        "  const safeFactoryClosure = safeClosureFactory();",
        '  const safeConditionalClosure = tx.confirmed ? safeClosure : () => "decorative";',
        '  const safeOptionalClosure = (value?: string) => value ?? "decorative";',
        '  const safeRestClosure = (...values: string[]) => values[0] ?? "decorative";',
        '  const safeDefaultClosure = (value = "decorative") => value;',
        '  const safeParameterArrayClosure = (values = ["decorative", tx.txid]) => values[0];',
        '  const { safeDefault = tx.txid } = { safeDefault: "decorative" };',
        '  const [safeArrayDefault = tx.txid] = ["decorative"];',
        '  const { leakedTxid: excludedLeak, ...safeObjectRest } = { leakedTxid: tx.txid, safe: "decorative" };',
        '  const [, ...safeArrayRest] = [tx.txid, "decorative"];',
        "  void excludedLeak;",
        '  const mixedWrapper = { leakedTxid: tx.txid, safe: "decorative" };',
        '  const mixedValues = ["decorative", tx.txid];',
        "  const safeCycle = () => false && safeCycle();",
      ].join("\n"),
    );
    mutant = insertAfterBidiValue(
      mutant,
      "src/features/wallet/History.tsx",
      "tx.txid",
      [
        "<span>{unrelatedTransaction[unrelatedProperty]}</span>",
        "<span>{safeLeak}</span>",
        "<span>{safeArrayLeak}</span>",
        "<span>{nestedSafeLeak}</span>",
        "<span>{computedSafeLeak}</span>",
        "<span>{safeWrapper.safeLeak}</span>",
        "<span>{nestedSafeWrapper.nested.safeLeak}</span>",
        "<span>{safeWrapper[safeKey]}</span>",
        "<span>{mixedWrapper.safe}</span>",
        "<span>{mixedValues[0]}</span>",
        "<span>{safeClosure()}</span>",
        "<span>{safeClosureAlias()}</span>",
        "<span>{safeClosureObject.selected()}</span>",
        "<span>{safeDestructuredObjectClosure()}</span>",
        "<span>{safeClosureArray[0]()}</span>",
        "<span>{safeDestructuredArrayClosure()}</span>",
        "<span>{safeBoundClosure()}</span>",
        "<span>{safeFactoryClosure()}</span>",
        "<span>{safeConditionalClosure()}</span>",
        "<span>{safeOptionalClosure()}</span>",
        "<span>{safeRestClosure()}</span>",
        "<span>{safeDefaultClosure()}</span>",
        "<span>{safeParameterArrayClosure()}</span>",
        "<span>{safeDefault}</span>",
        "<span>{safeArrayDefault}</span>",
        "<span>{safeObjectRest.safe}</span>",
        "<span>{safeArrayRest[0]}</span>",
        "<span>{safeCycle()}</span>",
        '<span>{(() => "decorative")()}</span>',
        '<span>{(tx.txid, "decorative")}</span>',
      ].join(""),
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).not.toThrow();
  });

  it("allows safe transparent expressions and same-name values in another scope", () => {
    let mutant = mutate(
      productionSources(),
      "src/features/wallet/Receive.tsx",
      "export function Receive() {",
      [
        "function DecorativeAddress({ address }: { address: string }) {",
        "  const alias = address;",
        "  return <span>{String(alias)}</span>;",
        "}",
        "void DecorativeAddress;",
        "",
        "export function Receive() {",
      ].join("\n"),
    );
    mutant = mutate(
      mutant,
      "src/features/wallet/Receive.tsx",
      "  const address = useWallet((s) => s.unifiedAddress);",
      [
        "  const address = useWallet((s) => s.unifiedAddress);",
        '  const safeLabel = "Wallet address";',
        "  const decorateLabel = (value: string) => value.toLowerCase();",
      ].join("\n"),
    );
    mutant = mutate(
      mutant,
      "src/features/wallet/Receive.tsx",
      `              <CopyButton
                value={address}`,
      [
        '              <span>{`${safeLabel}`}</span>',
        "              <span>{safeLabel.slice(0, 6)}</span>",
        "              <span>{safeLabel.substring(0, 6)}</span>",
        '              <span>{safeLabel.replace("Wallet", "Account")}</span>',
        "              <span>{safeLabel.toLowerCase()}</span>",
        '              <span>{safeLabel.split("").join("")}</span>',
        '              <span>{safeLabel.split("").reverse().join("")}</span>',
        '              <span>{[...safeLabel].join("")}</span>',
        "              <span>{safeLabel[0]}</span>",
        "              <span title={safeLabel}>Safe label</span>",
        "              <span {...{ title: safeLabel }}>Safe label</span>",
        "              <span {...{ safeLabel }}>Safe label</span>",
        "              <span {...{ ...{ title: safeLabel } }}>Safe label</span>",
        "              <span>{decorateLabel(safeLabel)}</span>",
        "              <CopyButton",
        "                value={address}",
      ].join("\n"),
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).not.toThrow();
  });

  it("allows an unrelated locally scoped component with the same name", () => {
    const mutant = mutate(
      productionSources(),
      "src/features/wallet/Receive.tsx",
      "export function Receive() {",
      [
        "function LocalBadge() {",
        "  const BidiIdentifier = () => <span>decorative</span>;",
        "  return <BidiIdentifier />;",
        "}",
        "void LocalBadge;",
        "",
        "export function Receive() {",
      ].join("\n"),
    );
    expect(() => assertBidiIdentifierPolicy(mutant)).not.toThrow();
  });

  it.each([
    ["src/features/wallet/Send.tsx", '              dir="ltr"'],
  ] as const)("rejects loss of literal input direction in %s", (file, dir) => {
    const mutant = mutate(productionSources(), file, dir, "");
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(/dir=ltr/);
  });
});
