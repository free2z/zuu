import { expect, it } from "vitest";
import ts from "typescript";

const sources = import.meta.glob(["../features/messages/**/*.ts", "../features/messages/**/*.tsx", "!../features/messages/**/*.test.ts", "!../features/messages/**/*.test.tsx"], { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

// Bounded source guard for the plaintext-owning UI. This deliberately rejects
// all dynamic Error arguments, rather than guessing whether an identifier is a
// message body. Whole-program alias/data-flow analysis remains a follow-on.
function dynamicErrors(source: string): string[] {
  const file = ts.createSourceFile("input.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isNewExpression(node) && /Error$/.test(node.expression.getText(file))) {
      for (const argument of node.arguments ?? []) {
        if (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument)) findings.push(argument.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return findings;
}
it("rejects dynamic Error construction throughout the plaintext-owning messages UI", () => {
  expect(Object.keys(sources).sort()).toEqual([
    "../features/messages/BrowserGuarantee.tsx",
    "../features/messages/Enrollment.tsx",
    "../features/messages/FirstContact.tsx",
    "../features/messages/Transcript.tsx",
    "../features/messages/index.tsx",
  ]);
  for (const [path, source] of Object.entries(sources)) expect(dynamicErrors(source), path).toEqual([]);
  expect(dynamicErrors('throw new Error(`send failed ${body}`)')).toHaveLength(1);
  expect(dynamicErrors('throw new TypeError(message.text)')).toHaveLength(1);
  expect(dynamicErrors('throw new TransportError("send failed", body)')).toHaveLength(1);
  expect(dynamicErrors('const example = "new Error(body)"')).toEqual([]);
  expect(dynamicErrors('throw new Error("send failed")')).toEqual([]);
});
