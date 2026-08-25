import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import walletComponents from "@/features/wallet/components.tsx?raw";
import historySource from "@/features/wallet/History.tsx?raw";
import receiveSource from "@/features/wallet/Receive.tsx?raw";
import sendSource from "@/features/wallet/Send.tsx?raw";
import loginSource from "@/features/auth/ZcashLoginFlow.tsx?raw";
import linkedAccountsSource from "@/features/profile/LinkedAccounts.tsx?raw";
import roomSource from "@/features/live/Room.tsx?raw";
import profileSource from "@/features/profile/index.tsx?raw";
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
  "src/features/profile/LinkedAccounts.tsx",
  "src/features/live/Room.tsx",
  "src/features/profile/index.tsx",
] as const;

function productionSources(): BidiProductionSources {
  return {
    "src/features/wallet/components.tsx": walletComponents,
    "src/features/wallet/History.tsx": historySource,
    "src/features/wallet/Receive.tsx": receiveSource,
    "src/features/wallet/Send.tsx": sendSource,
    "src/features/auth/ZcashLoginFlow.tsx": loginSource,
    "src/features/profile/LinkedAccounts.tsx": linkedAccountsSource,
    "src/features/live/Room.tsx": roomSource,
    "src/features/profile/index.tsx": profileSource,
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

describe("opaque identifier production inventory", () => {
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
      before: `<BidiIdentifier\n                  value={proposal.review.payments[0]?.recipient ?? ""}\n                  className="mono-id min-w-0 break-all text-end font-mono text-xs"\n                  data-testid="send-review-recipient"\n                />`,
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

  it("rejects laundering the DID through an executable alias", () => {
    let mutant = mutate(
      productionSources(),
      "src/features/profile/LinkedAccounts.tsx",
      "  const did = identity ? `did:zcash:${identity}` : null;",
      "  const did = identity ? `did:zcash:${identity}` : null;\n  const displayAlias = did;",
    );
    mutant = mutate(
      mutant,
      "src/features/profile/LinkedAccounts.tsx",
      "                value={did}",
      "                value={displayAlias}",
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
    ["src/features/profile/index.tsx", '              dir="ltr"'],
  ] as const)("rejects loss of literal input direction in %s", (file, dir) => {
    const mutant = mutate(productionSources(), file, dir, "");
    expect(() => assertBidiIdentifierPolicy(mutant)).toThrow(/dir=ltr/);
  });
});
