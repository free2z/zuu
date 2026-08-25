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
    /ArrowLeft must mirror/,
  );
  rejectsMutation(
    "src/features/articles/components/Comments/CommentCard.tsx",
    '<Reply className="rtl:-scale-x-100 h-4 w-4"',
    '<Reply className="h-4 w-4"',
    /Reply must mirror/,
  );
  rejectsMutation(
    "src/features/articles/components/Comments/CommentForm.tsx",
    '<SendIcon className="rtl:-scale-x-100 h-4 w-4"',
    '<SendIcon className="h-4 w-4"',
    /SendIcon must mirror/,
  );
});

test("direction-sensitive horizontal translations require explicit LTR and RTL signs", () => {
  rejectsMutation(
    "src/components/ui/switch.tsx",
    "ltr:data-[state=checked]:translate-x-5 rtl:data-[state=checked]:-translate-x-5",
    "data-[state=checked]:translate-x-5",
    /residual paths/,
  );
  rejectsMutation(
    "src/features/auth/ZcashLoginFlow.tsx",
    "ltr:-translate-x-1/2 rtl:translate-x-1/2",
    "-translate-x-1/2",
    /residual paths/,
  );
  rejectsMutation(
    "src/features/profile/LinkedAccounts.tsx",
    "ltr:-translate-x-1/2 rtl:translate-x-1/2",
    "-translate-x-1/2",
    /residual paths/,
  );
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

  rejectsMutation(
    "src/features/articles/components/ArticleCard.tsx",
    "{ backgroundImage: coverTone(article.title) }",
    '{ marginLeft: "1px" }',
    /inline style must use a logical-direction property/,
  );
});
