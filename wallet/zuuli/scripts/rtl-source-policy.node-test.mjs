import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRtlSourcePolicy,
  collectRtlSources,
} from "./rtl-source-policy.mjs";

const BASELINE = collectRtlSources();

function mutate(fileName, before, after) {
  const original = BASELINE[fileName];
  assert.equal(typeof original, "string", `missing mutation source ${fileName}`);
  const changed = original.replace(before, after);
  assert.notEqual(changed, original, `mutation did not apply to ${fileName}`);
  return { ...BASELINE, [fileName]: changed };
}

function rejectsMutation(fileName, before, after, pattern) {
  assert.throws(
    () => assertRtlSourcePolicy(mutate(fileName, before, after)),
    pattern,
  );
}

test("the current production tree satisfies the exact RTL source policy", () => {
  assert.doesNotThrow(() => assertRtlSourcePolicy(BASELINE));
});

test("physical margin, padding, position, border, and alignment mutants fail", () => {
  rejectsMutation(
    "src/components/layout/Sidebar.tsx",
    "border-e",
    "border-r",
    /residual paths/,
  );
  rejectsMutation(
    "src/components/layout/TopBar.tsx",
    "start-3",
    "left-3",
    /residual paths/,
  );
  rejectsMutation(
    "src/components/layout/TopBar.tsx",
    "ps-9",
    "pl-9",
    /residual paths/,
  );
  rejectsMutation(
    "src/components/ui/dialog.tsx",
    "text-start",
    "text-left",
    /residual paths/,
  );
});

test("a directional adornment that stops mirroring fails", () => {
  rejectsMutation(
    "src/components/layout/TopBar.tsx",
    '<ArrowLeft className="rtl:-scale-x-100 h-5 w-5"',
    '<ArrowLeft className="h-5 w-5"',
    /ArrowLeft.*must mirror/,
  );
  rejectsMutation(
    "src/features/articles/components/Comments/CommentCard.tsx",
    '<Reply className="rtl:-scale-x-100 h-4 w-4"',
    '<Reply className="h-4 w-4"',
    /Reply.*must mirror/,
  );
  rejectsMutation(
    "src/features/articles/components/Comments/CommentForm.tsx",
    '<SendIcon className="rtl:-scale-x-100 h-4 w-4"',
    '<SendIcon className="h-4 w-4"',
    /SendIcon.*must mirror/,
  );
});

test("directional Lucide aliases and namespace JSX resolve to imported symbols", () => {
  const card = BASELINE["src/features/articles/components/Comments/CommentCard.tsx"];
  const aliasedImport = card.replace(
    "MessageSquare, Reply }",
    "MessageSquare, Reply as Answer }",
  );
  assert.notEqual(aliasedImport, card, "Reply alias import mutation did not apply");
  const aliased = aliasedImport.replace("<Reply ", "<Answer ");
  assert.notEqual(aliased, aliasedImport, "Reply alias JSX mutation did not apply");
  assert.doesNotThrow(() =>
    assertRtlSourcePolicy({
      ...BASELINE,
      "src/features/articles/components/Comments/CommentCard.tsx": aliased,
    }),
  );
  assert.throws(
    () =>
      assertRtlSourcePolicy({
        ...BASELINE,
        "src/features/articles/components/Comments/CommentCard.tsx": aliased.replace(
          'className="rtl:-scale-x-100 h-4 w-4"',
          'className="h-4 w-4"',
        ),
      }),
    /Answer.*Reply.*must mirror/,
  );
  const shadowedAlias = aliased
    .replace(
      "export function CommentCard({ comment, numChildren, onReplied }: CommentCardProps) {",
      "export function CommentCard({ comment, numChildren, onReplied }: CommentCardProps) {\n  const Answer = () => <span />;",
    )
    .replace(
      'className="rtl:-scale-x-100 h-4 w-4"',
      'className="h-4 w-4"',
    );
  assert.notEqual(shadowedAlias, aliased, "Lucide alias shadow mutation did not apply");
  assert.doesNotThrow(() =>
    assertRtlSourcePolicy({
      ...BASELINE,
      "src/features/articles/components/Comments/CommentCard.tsx": shadowedAlias,
    }),
  );

  const namespaceImport = card.replace(
    'import { ChevronDown, ChevronUp, MessageSquare, Reply } from "lucide-react";',
    'import { ChevronDown, ChevronUp, MessageSquare } from "lucide-react";\nimport * as Lucide from "lucide-react";',
  );
  assert.notEqual(namespaceImport, card, "Lucide namespace import mutation did not apply");
  const namespaced = namespaceImport.replace("<Reply ", "<Lucide.Reply ");
  assert.notEqual(namespaced, namespaceImport, "Lucide namespace JSX mutation did not apply");
  assert.doesNotThrow(() =>
    assertRtlSourcePolicy({
      ...BASELINE,
      "src/features/articles/components/Comments/CommentCard.tsx": namespaced,
    }),
  );
  assert.throws(
    () =>
      assertRtlSourcePolicy({
        ...BASELINE,
        "src/features/articles/components/Comments/CommentCard.tsx": namespaced.replace(
          'className="rtl:-scale-x-100 h-4 w-4"',
          'className="h-4 w-4"',
        ),
      }),
    /Lucide\.Reply.*must mirror/,
  );
  const shadowedNamespace = namespaced
    .replace(
      "export function CommentCard({ comment, numChildren, onReplied }: CommentCardProps) {",
      "export function CommentCard({ comment, numChildren, onReplied }: CommentCardProps) {\n  const Lucide = { Reply: () => <span /> };",
    )
    .replace(
      'className="rtl:-scale-x-100 h-4 w-4"',
      'className="h-4 w-4"',
    );
  assert.notEqual(shadowedNamespace, namespaced, "Lucide namespace shadow mutation did not apply");
  assert.doesNotThrow(() =>
    assertRtlSourcePolicy({
      ...BASELINE,
      "src/features/articles/components/Comments/CommentCard.tsx": shadowedNamespace,
    }),
  );

  const localSameName = BASELINE["src/features/home/parts.tsx"].replace(
    'import { cn } from "@/lib/utils";\n',
    'import { cn } from "@/lib/utils";\n\nconst Reply = () => <span />;\nconst LocalReplyProbe = () => <Reply />;\nvoid LocalReplyProbe;\n',
  );
  assert.notEqual(localSameName, BASELINE["src/features/home/parts.tsx"]);
  assert.doesNotThrow(() =>
    assertRtlSourcePolicy({
      ...BASELINE,
      "src/features/home/parts.tsx": localSameName,
    }),
  );
});

test("direction-sensitive horizontal translations require explicit LTR and RTL signs", () => {
  for (const contract of [
    {
      file: "src/components/ui/switch.tsx",
      ltr: "ltr:data-[state=checked]:translate-x-5",
      rtl: "rtl:data-[state=checked]:-translate-x-5",
      badLtr: "ltr:data-[state=checked]:-translate-x-5",
      badRtl: "rtl:data-[state=checked]:translate-x-5",
    },
    {
      file: "src/features/auth/ZcashLoginFlow.tsx",
      ltr: "ltr:-translate-x-1/2",
      rtl: "rtl:translate-x-1/2",
      badLtr: "ltr:translate-x-1/2",
      badRtl: "rtl:-translate-x-1/2",
    },
    {
      file: "src/features/profile/LinkedAccounts.tsx",
      ltr: "ltr:-translate-x-1/2",
      rtl: "rtl:translate-x-1/2",
      badLtr: "ltr:translate-x-1/2",
      badRtl: "rtl:-translate-x-1/2",
    },
  ]) {
    rejectsMutation(contract.file, contract.ltr, "", /directional translation|reviewed directional/);
    rejectsMutation(contract.file, contract.rtl, "", /directional translation|reviewed directional/);
    rejectsMutation(contract.file, contract.ltr, contract.badLtr, /opposite-sign|reviewed directional/);
    rejectsMutation(contract.file, contract.rtl, contract.badRtl, /opposite-sign|reviewed directional/);
    rejectsMutation(
      contract.file,
      `${contract.ltr} ${contract.rtl}`,
      "",
      /reviewed directional/,
    );
  }
});

test("physical corner utilities fail", () => {
  for (const corner of ["tl", "tr", "bl", "br"]) {
    rejectsMutation(
      "src/features/messages/BrowserGuarantee.tsx",
      'className="space-y-4"',
      `className="rounded-${corner}-md space-y-4"`,
      /residual paths/,
    );
  }
});

test("a numeric typography site that loses bidi isolation fails", () => {
  rejectsMutation(
    "src/features/wallet/shared.tsx",
    "bidi-number numeral",
    "numeral",
    /residual paths/,
  );
});

test("numeric isolation cannot be satisfied by a decorative or incomplete rule", () => {
  rejectsMutation(
    "src/index.css",
    "direction: ltr;",
    "direction: inherit;",
    /bidi-number/,
  );
  rejectsMutation(
    "src/index.css",
    "unicode-bidi: isolate;",
    "unicode-bidi: normal;",
    /bidi-number/,
  );
});

test("document direction bootstrap removal fails", () => {
  rejectsMutation(
    "src/main.tsx",
    "installDocumentDirection();",
    "// installDocumentDirection();",
    /install document direction/,
  );
  rejectsMutation('index.html', ' dir="ltr"', "", /lang=en dir=ltr baseline/);

  const main = BASELINE["src/main.tsx"];
  const withoutEarlyCall = main.replace("installDocumentDirection();\n\n", "");
  assert.notEqual(withoutEarlyCall, main, "direction-call move did not remove");
  const movedAfterRender = withoutEarlyCall.replace(
    "\n// This is a build/runtime integration proof",
    "\ninstallDocumentDirection();\n\n// This is a build/runtime integration proof",
  );
  assert.notEqual(
    movedAfterRender,
    withoutEarlyCall,
    "direction-call move did not insert",
  );
  assert.throws(
    () =>
      assertRtlSourcePolicy({
        ...BASELINE,
        "src/main.tsx": movedAfterRender,
      }),
    /before rendering/,
  );
});

test("a broad messaging exclusion cannot admit another path", () => {
  rejectsMutation(
    "src/features/messages/BrowserGuarantee.tsx",
    'className="space-y-4"',
    'className="ml-2 space-y-4"',
    /residual paths/,
  );
});

test("deleting a reviewed messaging residual fails closed", () => {
  rejectsMutation(
    "src/features/messages/Transcript.tsx",
    "text-right text-xs",
    "text-end text-xs",
    /residual paths/,
  );
});

test("messaging residual count drift fails closed", () => {
  rejectsMutation(
    "src/features/messages/index.tsx",
    'className="numeral mt-1 text-foreground"',
    'className="numeral numeral mt-1 text-foreground"',
    /residuals changed/,
  );
});

test("physical CSS declarations fail even without Tailwind", () => {
  rejectsMutation(
    "src/components/common/markdown.css",
    "margin-inline-start: -8px;",
    "margin-left: -8px;",
    /physical-direction CSS/,
  );
  rejectsMutation(
    "src/main.tsx",
    "paddingInlineStart:",
    "paddingLeft:",
    /inline style must use a logical-direction property/,
  );

  const section = BASELINE["src/features/home/parts.tsx"];
  const withNamedDeclaration = section.replace(
    "  return (\n    <section",
    '  const badStyle = { left: "1px" };\n  return (\n    <section',
  );
  assert.notEqual(
    withNamedDeclaration,
    section,
    "named-style declaration mutation did not apply",
  );
  const withNamedStyle = withNamedDeclaration.replace(
    '      style={{ animationDelay: `${delay}ms` }}',
    "      style={badStyle}",
  );
  assert.notEqual(
    withNamedStyle,
    withNamedDeclaration,
    "named-style use mutation did not apply",
  );
  assert.throws(
    () =>
      assertRtlSourcePolicy({
        ...BASELINE,
        "src/features/home/parts.tsx": withNamedStyle,
      }),
    /inline style must use a logical-direction property/,
  );

  const withLogicalDeclaration = section.replace(
    "  return (\n    <section",
    '  const logicalStyle = { marginInlineStart: "1px" };\n  return (\n    <section',
  );
  assert.notEqual(
    withLogicalDeclaration,
    section,
    "logical named-style declaration mutation did not apply",
  );
  const withLogicalStyle = withLogicalDeclaration.replace(
    '      style={{ animationDelay: `${delay}ms` }}',
    "      style={logicalStyle}",
  );
  assert.notEqual(
    withLogicalStyle,
    withLogicalDeclaration,
    "logical named-style use mutation did not apply",
  );
  assert.doesNotThrow(() =>
    assertRtlSourcePolicy({
      ...BASELINE,
      "src/features/home/parts.tsx": withLogicalStyle,
    }),
  );

  rejectsMutation(
    "src/features/articles/components/ArticleCard.tsx",
    "{ backgroundImage: coverTone(article.title) }",
    '{ marginLeft: "1px" }',
    /inline style must use a logical-direction property/,
  );
});

test("asymmetric CSS shorthands fail while symmetric function-valued forms pass", () => {
  const cssFile = "src/components/common/markdown.css";
  const withCss = (declaration) => ({
    ...BASELINE,
    [cssFile]: `${BASELINE[cssFile]}\n.rtl-shorthand-probe { ${declaration} }\n`,
  });
  for (const declaration of [
    "margin: calc(1px + 2px) 4px 0 8px;",
    "padding: var(--block) min(2px, 3px) 0 max(4px, 5px);",
    "border-radius: 1px 2px 3px;",
    "border-radius: calc(1px + 2px) 4px 8px 16px / var(--a) var(--b) var(--c) var(--d);",
  ]) {
    assert.throws(
      () => assertRtlSourcePolicy(withCss(declaration)),
      /asymmetric physical CSS shorthand/,
      declaration,
    );
  }
  for (const declaration of [
    "margin: calc(1px + 2px) var(--inline) 0 var(--inline);",
    "padding: var(--top) min(2px, 3px) var(--bottom);",
    "border-radius: calc(1px + 2px) calc(1px + 2px) var(--bottom) var(--bottom);",
    "border-radius: var(--all) / max(2px, 3px);",
  ]) {
    assert.doesNotThrow(
      () => assertRtlSourcePolicy(withCss(declaration)),
      declaration,
    );
  }
});

test("named inline styles resolve by lexical declaration and retain deep red controls", () => {
  const fileName = "src/features/home/parts.tsx";
  const source = BASELINE[fileName];
  const insert = (secondProperty) => source.replace(
    'import { cn } from "@/lib/utils";\n',
    [
      'import { cn } from "@/lib/utils";',
      "",
      'function ScopedStyleOne() { const sharedName = { marginInlineStart: "1px" }; return <i style={sharedName} />; }',
      `function ScopedStyleTwo() { const sharedName = { ${secondProperty}: "1px" }; return <i style={sharedName} />; }`,
      "void ScopedStyleOne; void ScopedStyleTwo;",
      "",
    ].join("\n"),
  );
  const safeScopes = insert("paddingInlineEnd");
  assert.notEqual(safeScopes, source, "scoped-style mutation did not apply");
  assert.doesNotThrow(() =>
    assertRtlSourcePolicy({ ...BASELINE, [fileName]: safeScopes }),
  );
  assert.throws(
    () => assertRtlSourcePolicy({ ...BASELINE, [fileName]: insert("marginLeft") }),
    /inline style must use a logical-direction property/,
  );

  const deepPhysical = source.replace(
    'import { cn } from "@/lib/utils";\n',
    [
      'import { cn } from "@/lib/utils";',
      "",
      'const physicalAlias = { right: "1px" };',
      'const physicalConditional = true ? physicalAlias : { insetInlineStart: "1px" };',
      'const physicalSpread = { ...physicalConditional };',
      'const PhysicalStyleProbe = () => <i style={physicalSpread} />;',
      "void PhysicalStyleProbe;",
      "",
    ].join("\n"),
  );
  assert.notEqual(deepPhysical, source, "deep style mutation did not apply");
  assert.throws(
    () => assertRtlSourcePolicy({ ...BASELINE, [fileName]: deepPhysical }),
    /inline style must use a logical-direction property/,
  );
});
