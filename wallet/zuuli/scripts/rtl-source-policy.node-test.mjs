import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import {
  CHAT_OWNED_RESIDUALS,
  assertRtlSourcePolicy,
  collectRtlSources,
} from "./rtl-source-policy.mjs";

const BASELINE = collectRtlSources();

/**
 * A production file with no directional residual of its own, used as the
 * neutral carrier for "does an added violation fail" mutations. It was
 * `src/features/messages/BrowserGuarantee.tsx` until #904 phase 3 moved the
 * messaging surface to `wallet/e2e2z`; the wallet's Send screen is the same
 * kind of subject and belongs to the app that keeps the seed, so it does not
 * move again.
 */
const CARRIER = Object.freeze({
  file: "src/features/wallet/Send.tsx",
  className: 'className="space-y-4"',
});

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

function insertJsxAttribute(
  fileName,
  tagName,
  attributeSource,
  placement = "end",
  sources = BASELINE,
) {
  const source = sources[fileName];
  assert.equal(typeof source, "string", `missing mutation source ${fileName}`);
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  assert.equal(file.parseDiagnostics.length, 0, `cannot parse ${fileName}`);
  const matches = [];
  const visit = (node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(file) === tagName
    ) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(matches.length, 1, `expected one ${tagName} in ${fileName}`);
  const attributes = matches[0].attributes;
  const position =
    placement === "start"
      ? (attributes.properties[0]?.getStart(file) ?? attributes.end)
      : attributes.end;
  const insertion = placement === "start" ? `${attributeSource} ` : ` ${attributeSource}`;
  const changed = `${source.slice(0, position)}${insertion}${source.slice(position)}`;
  assert.notEqual(changed, source, `mutation did not apply to ${fileName}`);
  return { ...sources, [fileName]: changed };
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
  for (const arbitrary of ["[margin-left:1px]", "[MARGIN-LEFT:1px]"]) {
    rejectsMutation(
      CARRIER.file,
      CARRIER.className,
      `className="${arbitrary} space-y-4"`,
      /residual paths/,
    );
  }

  const logicalArbitrary = mutate(
    CARRIER.file,
    CARRIER.className,
    'className="[margin-inline-start:1px] space-y-4"',
  );
  assert.doesNotThrow(() => assertRtlSourcePolicy(logicalArbitrary));
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

  const laterSpread = insertJsxAttribute(
    "src/features/articles/components/Comments/CommentCard.tsx",
    "Reply",
    '{...{ className: "h-4 w-4" }}',
  );
  assert.throws(() => assertRtlSourcePolicy(laterSpread), /Reply.*must mirror/);

  const earlierSpread = insertJsxAttribute(
    "src/features/articles/components/Comments/CommentCard.tsx",
    "Reply",
    '{...{ className: "h-4 w-4" }}',
    "start",
  );
  assert.doesNotThrow(() => assertRtlSourcePolicy(earlierSpread));

  const inlineCancellation = insertJsxAttribute(
    "src/features/articles/components/Comments/CommentCard.tsx",
    "Reply",
    'style={{ transform: "none" }}',
  );
  assert.throws(
    () => assertRtlSourcePolicy(inlineCancellation),
    /Reply.*inline style.*directional transform/,
  );

  const harmlessInlineStyle = insertJsxAttribute(
    "src/features/articles/components/Comments/CommentCard.tsx",
    "Reply",
    'style={{ color: "currentColor" }}',
  );
  assert.doesNotThrow(() => assertRtlSourcePolicy(harmlessInlineStyle));
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
      CARRIER.file,
      CARRIER.className,
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

// The reviewed residual inventory used to hold the messaging screens, which
// #904 phase 3 moved to `wallet/e2e2z`. It is empty now, which makes this
// policy strictly stricter — but "empty" is the state most likely to be
// mistaken for "switched off", so these three prove the mechanism is still
// live in every direction it can still be exercised in. RTL enforcement for
// the moved screens themselves has not been ported to `wallet/e2e2z` yet; that
// app has no document-direction bootstrap to hold to, and building one is its
// own change rather than a silent half-measure here.
test("the reviewed residual inventory is empty and enforced as empty", () => {
  assert.deepEqual(Object.keys(CHAT_OWNED_RESIDUALS), []);
  // An empty inventory is not an absent one: a residual anywhere fails, and the
  // failure names the paths rather than shrugging.
  rejectsMutation(
    CARRIER.file,
    CARRIER.className,
    'className="ml-2 space-y-4"',
    /residual paths/,
  );
});

test("an empty inventory admits no path, in any file", () => {
  // Three unrelated trees, so a future exemption cannot be smuggled in as a
  // directory rule the way a single carrier file might allow.
  for (const [file, before, after] of [
    ["src/components/layout/Sidebar.tsx", "border-e", "border-r"],
    ["src/components/ui/dialog.tsx", "text-start", "text-left"],
    [CARRIER.file, CARRIER.className, 'className="text-left space-y-4"'],
  ]) {
    rejectsMutation(file, before, after, /residual paths/);
  }
});

test("repeated residuals in one file still fail on the path set", () => {
  // The per-file *count* comparison is dormant while the inventory is empty —
  // with no reviewed file, any residual changes the path set before a count
  // can differ, so `residuals changed` is unreachable and this asserts the
  // reachable failure rather than pretending otherwise. The counting branch
  // stays in the policy for the next surface that earns a counted exception.
  rejectsMutation(
    CARRIER.file,
    CARRIER.className,
    'className="text-left text-left space-y-4"',
    /residual paths/,
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
    "src/app-bootstrap.tsx",
    "paddingInlineStart:",
    "paddingLeft:",
    /inline style must use a logical-direction property/,
  );
  const cssFile = "src/components/common/markdown.css";
  assert.throws(
    () =>
      assertRtlSourcePolicy({
        ...BASELINE,
        [cssFile]: `${BASELINE[cssFile]}\n.uppercase-probe { MARGIN-LEFT: 1px; }\n`,
      }),
    /physical-direction CSS/,
  );
  assert.doesNotThrow(() =>
    assertRtlSourcePolicy({
      ...BASELINE,
      [cssFile]: `${BASELINE[cssFile]}\n.uppercase-safe { TEXT-ALIGN: CENTER; }\n`,
    }),
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
    "inset: 0 1rem 0 2rem;",
    "border-width: 1px 2px 1px 3px;",
    "border-style: solid dashed solid dotted;",
    "border-color: red green red blue;",
    "scroll-margin: 0 1rem 0 2rem;",
    "scroll-padding: 0 1rem 0 2rem;",
    "border-image-width: 1px 2px 1px 3px;",
    "border-image-outset: 1px 2px 1px 3px;",
    "border-image-slice: 1 2 1 3 fill;",
    "mask-border-width: 1px 2px 1px 3px;",
    "mask-border-outset: 1px 2px 1px 3px;",
    "mask-border-slice: fill 1 2 1 3;",
    "border-image: url(frame.png) 1 / 1px 2px 1px 3px;",
    "mask-border: url(mask.png) 1 / 1px 2px 1px 3px;",
    "border-image: url(frame.png) 1 / 1px 2px 1px 3px / 0;",
    "mask-border: url(mask.png) 1 / 1px 2px 1px 3px / 0;",
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
    "inset: 0 var(--inline) 0 var(--inline);",
    "border-width: 1px 2px 1px 2px;",
    "border-style: solid dashed solid dashed;",
    "border-color: red green red green;",
    "scroll-margin: 0 var(--inline) 0 var(--inline);",
    "scroll-padding: 0 var(--inline) 0 var(--inline);",
    "border-image-width: 1px 2px 1px 2px;",
    "border-image-outset: 1px 2px 1px 2px;",
    "border-image-slice: 1 2 1 2 fill;",
    "mask-border-width: 1px 2px 1px 2px;",
    "mask-border-outset: 1px 2px 1px 2px;",
    "mask-border-slice: fill 1 2 1 2;",
    "border-image: url(frame.png) 1 / 1px 2px 1px 2px;",
    "mask-border: url(mask.png) 1 / 1px 2px 1px 2px;",
    "border-image: url(frame.png) 1 / 1px 2px 1px 2px / 0;",
    "mask-border: url(mask.png) 1 / 1px 2px 1px 2px / 0;",
    "border-radius: calc(1px + 2px) calc(1px + 2px) var(--bottom) var(--bottom);",
    "--all: 1px; border-radius: var(--all) / max(2px, 3px);",
  ]) {
    assert.doesNotThrow(
      () => assertRtlSourcePolicy(withCss(declaration)),
      declaration,
    );
  }
});

test("directional shorthands resolve same-file custom properties and fail closed", () => {
  const cssFile = "src/components/common/markdown.css";
  const withCss = (declarations) => ({
    ...BASELINE,
    [cssFile]: `${BASELINE[cssFile]}\n.rtl-custom-property-probe { ${declarations} }\n`,
  });
  for (const declarations of [
    "--review-spacing: 0 1px 0 2px; margin: var(--review-spacing);",
    "--review-width: 1px 2px 1px 3px; border-image: url(frame.png) 1 / var(--review-width) / 0;",
    "--review-width: 1px 2px 1px 3px; mask-border: url(mask.png) 1 / var(--review-width) / 0;",
    "margin: var(--missing-review-spacing);",
    "--review-spacing: 0 1px 0 1px; margin: var(--review-spacing, 0 1px 0 2px);",
    "--review-a: var(--review-b); --review-b: var(--review-a); margin: var(--review-a, 0 1px 0 2px);",
  ]) {
    assert.throws(
      () => assertRtlSourcePolicy(withCss(declarations)),
      /asymmetric physical CSS shorthand/,
      declarations,
    );
  }
  for (const declarations of [
    "--review-spacing: 0 1px 0 1px; margin: var(--review-spacing);",
    "margin: 0 var(--shared-inline) 0 var(--shared-inline);",
    "padding: var(--block-start) var(--shared-inline) var(--block-end);",
    "--review-width: 1px 2px 1px 2px; border-image: url(frame.png) 1 / var(--review-width) / 0;",
    "--review-color: rebeccapurple; color: var(--review-color);",
    "--Review-Spacing: 0 1px 0 2px; margin: var(--review-spacing, 0 1px 0 1px);",
    "--review-a: var(--review-b); --review-b: var(--review-a); margin: var(--review-a, 0 1px 0 1px);",
  ]) {
    assert.doesNotThrow(
      () => assertRtlSourcePolicy(withCss(declarations)),
      declarations,
    );
  }
});

test("React physical shorthand values fail when asymmetric and allow symmetric controls", () => {
  const fileName = "src/features/articles/components/Comments/CommentCard.tsx";
  for (const style of [
    'margin: "0 1px 0 2px"',
    'borderImageWidth: "1px 2px 1px 3px"',
    'maskBorderSlice: "1 2 1 3 fill"',
    'borderImage: "url(frame.png) 1 / 1px 2px 1px 3px"',
    'maskBorder: "url(mask.png) 1 / 1px 2px 1px 3px"',
  ]) {
    const mutant = insertJsxAttribute(
      fileName,
      "Reply",
      `style={{ ${style} }}`,
    );
    assert.throws(
      () => assertRtlSourcePolicy(mutant),
      /inline style contains an asymmetric physical shorthand/,
      style,
    );
  }
  for (const style of [
    'margin: "0 1px 0 1px"',
    'borderImageWidth: "1px 2px 1px 2px"',
    'maskBorderSlice: "1 2 1 2 fill"',
    'borderImage: "url(frame.png) 1 / 1px 2px 1px 2px"',
    'maskBorder: "url(mask.png) 1 / 1px 2px 1px 2px"',
  ]) {
    const control = insertJsxAttribute(
      fileName,
      "Reply",
      `style={{ ${style} }}`,
    );
    assert.doesNotThrow(() => assertRtlSourcePolicy(control), style);
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

  const alignmentAliases = (secondValue) => source.replace(
    'import { cn } from "@/lib/utils";\n',
    [
      'import { cn } from "@/lib/utils";',
      "",
      'function SafeAlignmentScope() { const alignment = "start" as const; return <i style={{ textAlign: alignment }} />; }',
      `function SecondAlignmentScope() { const alignment = ${JSON.stringify(secondValue)} as const; const alias = alignment; return <i style={{ textAlign: alias }} />; }`,
      "void SafeAlignmentScope; void SecondAlignmentScope;",
      "",
    ].join("\n"),
  );
  const safeAlignmentAliases = alignmentAliases("end");
  assert.notEqual(safeAlignmentAliases, source, "alignment alias mutation did not apply");
  assert.doesNotThrow(() =>
    assertRtlSourcePolicy({ ...BASELINE, [fileName]: safeAlignmentAliases }),
  );
  assert.throws(
    () => assertRtlSourcePolicy({ ...BASELINE, [fileName]: alignmentAliases("left") }),
    /inline textAlign must be logical/,
  );
});
