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
});
