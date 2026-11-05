import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { parse } from "svelte/compiler";

const baselineFile =
  process.env.FORMATTING_BASELINE ?? "tests/formatting-inventory.json";
const root = "src";
const methods = new Set([
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
  "localeCompare",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toISOString",
]);
const constructors = new Set([
  "NumberFormat",
  "DateTimeFormat",
  "RelativeTimeFormat",
  "ListFormat",
  "Collator",
  "DisplayNames",
  "Segmenter",
  "Locale",
  "PluralRules",
  "getCanonicalLocales",
]);
function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(path.join(dir, entry.name))
        : /\.(js|ts|svelte)$/.test(entry.name)
          ? [path.join(dir, entry.name)]
          : [],
    );
}
function walk(node, fn, parent = null) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, fn, parent));
    return;
  }
  fn(node, parent);
  for (const [key, value] of Object.entries(node))
    if (key !== "metadata" && key !== "parent") walk(value, fn, node);
}
function category(file, kind, context) {
  if (kind === "Intl.object" && file === "src/lib/components/converse/utils.ts")
    return [
      "specialized",
      "Feature detection for grapheme segmentation; preserve capability fallback.",
    ];
  if (kind === "toISOString" && file === "src/lib/utils/date.ts")
    return [
      "specialized",
      "Fallback for invalid formatter options returns an ISO representation; preserve date failure behavior.",
    ];
  if (kind === "toLocaleLowerCase" || kind === "toLocaleUpperCase")
    return [
      "specialized",
      "Case normalization for comparison or identifier matching; audit locale dependence before changing matching semantics.",
    ];
  if (kind === "Intl.Segmenter")
    return [
      "specialized",
      "Grapheme segmentation protects text boundaries rather than formatting displayed dates or numbers.",
    ];
  if (kind === "toISOString")
    return [
      "machine",
      "ISO timestamp is a machine protocol value; retain canonical UTC serialization.",
    ];
  if (kind === "Intl.Locale" || kind === "Intl.getCanonicalLocales")
    return [
      "specialized",
      "Canonicalizes or inspects a language tag rather than formatting product copy.",
    ];
  if (file === "src/lib/i18n.ts" || file === "src/lib/utils/date.ts")
    return [
      "shared",
      "Shared request-aware formatting implementation; changes require review of all callers.",
    ];
  if (
    [
      "src/lib/economy-values.js",
      "src/lib/insufficient-funds.ts",
      "src/lib/utils/format-tuzis.ts",
    ].includes(file)
  )
    return [
      "fixed-precision",
      "Preserves decimal-string or BigInt value and locale separators; migrate only with exact-value regression coverage.",
    ];
  if (
    file === "src/lib/components/SeriesEditor.svelte" ||
    file === "src/lib/social-card-text.ts"
  )
    return [
      "machine",
      "Stable identifier or protocol ordering/segmentation, independent of viewer UI language.",
    ];
  if (kind === "date-fns-import")
    return [
      "legacy",
      "Audit imported date helpers and migrate user-facing output to the shared date API.",
    ];
  if (
    file === "src/lib/components/mdEditor/utils.ts" &&
    context === "Intl.DateTimeFormat()"
  )
    return [
      "specialized",
      "Detects the device time-zone identifier; this is not a formatted UI date.",
    ];
  if (
    file === "src/lib/language-picker.js" ||
    file === "src/lib/language-catalog.js" ||
    file === "src/lib/zpage-language.js"
  )
    return [
      "legacy",
      "Content-language names or ordering: preserve arbitrary language tags while migrating to shared locale-aware formatting.",
    ];
  return [
    "legacy",
    `Migrate ${kind} at this exact call to a shared locale-aware helper; preserve its arguments, options and precision.`,
  ];
}
const items = [];
function add(file, kind, context) {
  const normalized = context.replace(/\s+/g, " ").trim();
  const fingerprint = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
  const [classification, rationale] = category(file, kind, normalized);
  items.push({
    file,
    kind,
    context: normalized,
    fingerprint,
    classification,
    owner: "Free2Z UI",
    rationale,
  });
}
for (const file of [
  ...files(root),
  ...(process.env.FORMATTING_PROBE ? [process.env.FORMATTING_PROBE] : []),
]) {
  const source = fs.readFileSync(file, "utf8");
  if (file.endsWith(".svelte")) {
    const ast = parse(source, { modern: true });
    walk(ast, (node, parent) => {
      if (
        node.type === "Identifier" &&
        node.name === "Intl" &&
        parent &&
        parent.type !== "MemberExpression" &&
        parent.type !== "TSQualifiedName"
      )
        add(file, "Intl.object", source.slice(parent.start, parent.end));
      if (
        node.type === "MemberExpression" &&
        methods.has(
          node.computed ? node.property?.value : node.property?.name,
        ) &&
        !(
          parent &&
          ["CallExpression", "NewExpression"].includes(parent.type) &&
          parent.callee === node
        )
      )
        add(file, "format-method.escape", source.slice(node.start, node.end));
      if (
        node.type === "MemberExpression" &&
        node.object?.name === "Intl" &&
        constructors.has(
          node.computed ? node.property?.value : node.property?.name,
        ) &&
        !(
          parent &&
          ["CallExpression", "NewExpression"].includes(parent.type) &&
          parent.callee === node
        )
      )
        add(file, "Intl.escape", source.slice(node.start, node.end));
      if (
        node.type === "ImportDeclaration" &&
        String(node.source?.value).startsWith("date-fns")
      )
        add(file, "date-fns-import", source.slice(node.start, node.end));
      if (
        node.type === "ImportExpression" &&
        typeof node.source?.value === "string" &&
        node.source.value.startsWith("date-fns")
      )
        add(file, "date-fns-import", source.slice(node.start, node.end));
      if (
        node.type === "CallExpression" &&
        node.callee?.name === "require" &&
        typeof node.arguments?.[0]?.value === "string" &&
        node.arguments[0].value.startsWith("date-fns")
      )
        add(file, "date-fns-import", source.slice(node.start, node.end));
      if (!["CallExpression", "NewExpression"].includes(node.type)) return;
      const callee = node.callee;
      if (callee?.type !== "MemberExpression") return;
      const name = callee.computed
        ? (callee.property?.value ?? "dynamic")
        : callee.property?.name;
      const intlObject =
        callee.object?.name === "Intl" ||
        (callee.object?.type === "MemberExpression" &&
          ["globalThis", "window"].includes(callee.object.object?.name) &&
          callee.object.property?.name === "Intl");
      if (intlObject && name === "dynamic") {
        add(file, "Intl.dynamic", source.slice(node.start, node.end));
        return;
      }
      if (intlObject && constructors.has(name))
        add(file, `Intl.${name}`, source.slice(node.start, node.end));
      else if (methods.has(name))
        add(file, name, source.slice(node.start, node.end));
    });
  } else {
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require")) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text.startsWith("date-fns")
      )
        add(file, "date-fns-import", node.getText(ast));
      if (
        ts.isIdentifier(node) &&
        node.text === "Intl" &&
        node.parent &&
        !ts.isPropertyAccessExpression(node.parent) &&
        !ts.isQualifiedName(node.parent)
      )
        add(file, "Intl.object", node.parent.getText(ast));
      if (
        ts.isPropertyAccessExpression(node) &&
        methods.has(node.name.text) &&
        !(
          (ts.isCallExpression(node.parent) ||
            ts.isNewExpression(node.parent)) &&
          node.parent.expression === node
        )
      )
        add(file, "format-method.escape", node.getText(ast));
      if (
        ts.isPropertyAccessExpression(node) &&
        node.expression.getText(ast) === "Intl" &&
        constructors.has(node.name.text) &&
        !(
          (ts.isCallExpression(node.parent) ||
            ts.isNewExpression(node.parent)) &&
          node.parent.expression === node
        )
      )
        add(file, "Intl.escape", node.getText(ast));
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith("date-fns")
      )
        add(file, "date-fns-import", node.getText(ast));
      if (
        (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        (ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression))
      ) {
        const expression = node.expression,
          name = ts.isPropertyAccessExpression(expression)
            ? expression.name.text
            : ts.isStringLiteral(expression.argumentExpression)
              ? expression.argumentExpression.text
              : "dynamic";
        if (
          ["Intl", "globalThis.Intl", "window.Intl"].includes(
            expression.expression.getText(ast),
          ) &&
          name === "dynamic"
        ) {
          add(file, "Intl.dynamic", node.getText(ast));
          ts.forEachChild(node, visit);
          return;
        }
        if (
          ["Intl", "globalThis.Intl", "window.Intl"].includes(
            expression.expression.getText(ast),
          ) &&
          constructors.has(name)
        )
          add(file, `Intl.${name}`, node.getText(ast));
        else if (methods.has(name)) add(file, name, node.getText(ast));
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
items.sort((a, b) =>
  `${a.file}:${a.kind}:${a.fingerprint}`.localeCompare(
    `${b.file}:${b.kind}:${b.fingerprint}`,
    "en",
  ),
);
{
  const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
  if (
    !process.env.FORMATTING_BASELINE &&
    (baseline.length > 105 ||
      baseline.filter((item) => item.classification === "legacy").length > 51)
  ) {
    console.error(
      "Formatting inventory may only shrink: maximum 105 sites and 51 legacy sites.",
    );
    process.exitCode = 1;
  }
  const counts = (xs) =>
    xs.reduce((map, item) => {
      const key = JSON.stringify(item);
      map.set(key, (map.get(key) ?? 0) + 1);
      return map;
    }, new Map());
  const expected = counts(baseline),
    actual = counts(items);
  const added = [...actual]
    .filter(([key, n]) => n > (expected.get(key) ?? 0))
    .map(([key]) => JSON.parse(key));
  const removed = [...expected]
    .filter(([key, n]) => n > (actual.get(key) ?? 0))
    .map(([key]) => JSON.parse(key));
  if (added.length || removed.length) {
    console.error(JSON.stringify({ added, removed }, null, 2));
    process.exitCode = 1;
  } else
    console.log(
      `Formatting inventory: ${items.length} classified sites; no new or stale exceptions.`,
    );
}
