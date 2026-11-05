import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ts from "typescript";
import { parse } from "svelte/compiler";

const root = path.resolve("src");
const baselinePath = "tests/i18n-call-baseline.json";
const oldBaseline = new Set(
  fs
    .readFileSync("tests/i18n-missing-keys-baseline.txt", "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")),
);
const english = JSON.parse(fs.readFileSync("src/lib/locales/en.json", "utf8"));
function hasKey(key) {
  const find = (k) =>
    typeof k
      .split(".")
      .reduce(
        (v, part) => (v && typeof v === "object" ? v[part] : undefined),
        english,
      ) === "string";
  return find(key) || (key.startsWith("common.") && find(key.slice(7)));
}
function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? ["api", "locales"].includes(e.name)
          ? []
          : files(path.join(dir, e.name))
        : /\.(svelte|ts|js)$/.test(e.name)
          ? [path.join(dir, e.name)]
          : [],
    );
}
const findings = [];
function record(file, callee, argument, call) {
  if (
    argument.type === "literal" &&
    (hasKey(argument.value) || oldBaseline.has(argument.value))
  )
    return;
  const kind = argument.type === "literal" ? "missing" : "dynamic";
  const fingerprint = crypto
    .createHash("sha256")
    .update(call.replace(/\s+/g, " "))
    .digest("hex")
    .slice(0, 16);
  findings.push(`${path.relative(".", file)}:${callee}:${kind}:${fingerprint}`);
}
function walkObject(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkObject(child, visit);
    return;
  }
  visit(node);
  for (const [key, value] of Object.entries(node))
    if (key !== "parent" && key !== "metadata") walkObject(value, visit);
}
for (const file of files(root)) {
  const source = fs.readFileSync(file, "utf8");
  if (file.endsWith(".svelte")) {
    const ast = parse(source, { modern: true });
    const names = new Set();
    walkObject(ast, (n) => {
      if (
        n.type === "Identifier" &&
        n.typeAnnotation?.typeAnnotation?.typeName?.name ===
          "TranslationFunction"
      )
        names.add(n.name);
      if (
        n.type === "ImportDeclaration" &&
        /(?:^|\/)i18n(?:-message)?$/.test(n.source?.value ?? "")
      )
        for (const spec of n.specifiers ?? []) {
          if (
            ["t", "tStore", "translate", "defineMessage"].includes(
              spec.imported?.name,
            )
          ) {
            names.add(spec.local.name);
            if (spec.imported.name === "tStore")
              names.add(`$${spec.local.name}`);
          }
        }
    });
    walkObject(ast, (n) => {
      if (
        n.type !== "CallExpression" ||
        n.callee?.type !== "Identifier" ||
        !names.has(n.callee.name)
      )
        return;
      const index = n.callee.name === "translate" ? 1 : 0;
      const a = n.arguments[index];
      if (!a) return;
      record(
        file,
        n.callee.name,
        a.type === "Literal" && typeof a.value === "string"
          ? { type: "literal", value: a.value }
          : { type: "dynamic" },
        source.slice(n.start, n.end),
      );
    });
  } else {
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    const names = new Map();
    for (const n of ast.statements)
      if (
        ts.isImportDeclaration(n) &&
        ts.isStringLiteral(n.moduleSpecifier) &&
        /(?:^|\/)i18n(?:-message)?$/.test(n.moduleSpecifier.text) &&
        n.importClause?.namedBindings &&
        ts.isNamedImports(n.importClause.namedBindings)
      )
        for (const spec of n.importClause.namedBindings.elements) {
          const imported = (spec.propertyName ?? spec.name).text;
          if (["t", "tStore", "translate", "defineMessage"].includes(imported))
            names.set(spec.name.text, imported === "translate" ? 1 : 0);
        }
    function visit(n) {
      if (
        n.name &&
        ts.isIdentifier(n.name) &&
        n.type &&
        ts.isTypeReferenceNode(n.type) &&
        n.type.typeName.getText(ast) === "TranslationFunction"
      )
        names.set(n.name.text, 0);
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        names.has(n.expression.text)
      ) {
        const a = n.arguments[names.get(n.expression.text)];
        if (a)
          record(
            file,
            n.expression.text,
            ts.isStringLiteralLike(a)
              ? { type: "literal", value: a.text }
              : { type: "dynamic" },
            n.getText(ast),
          );
      }
      ts.forEachChild(n, visit);
    }
    function collect(n) {
      if (
        n.name &&
        ts.isIdentifier(n.name) &&
        n.type &&
        ts.isTypeReferenceNode(n.type) &&
        n.type.typeName.getText(ast) === "TranslationFunction"
      )
        names.set(n.name.text, 0);
      ts.forEachChild(n, collect);
    }
    collect(ast);
    visit(ast);
  }
}
findings.sort();
{
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const count = (items) =>
    items.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
  const expected = count(baseline),
    actual = count(findings);
  const added = [...actual].filter(([x, n]) => n > (expected.get(x) ?? 0));
  const removed = [...expected].filter(([x, n]) => n > (actual.get(x) ?? 0));
  if (added.length || removed.length) {
    console.error(JSON.stringify({ added, removed }, null, 2));
    process.exitCode = 1;
  } else
    console.log(
      `i18n census: ${findings.length} owned legacy exceptions; no new calls`,
    );
}
