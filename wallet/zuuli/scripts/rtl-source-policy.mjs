import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

const DIRECTIONAL_ICONS = new Set([
  "ArrowDownLeft",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUpRight",
  "LogIn",
  "LogOut",
  "Reply",
  "SendIcon",
]);

// Messaging is owned by the parallel E2EE effort. This is deliberately an
// exact residual inventory, not a directory exemption: a new path, a removed
// residual, or one extra occurrence fails the same policy as non-chat code.
export const CHAT_OWNED_RESIDUALS = Object.freeze({
  "src/features/messages/Transcript.tsx": Object.freeze(["text-right"]),
  "src/features/messages/index.tsx": Object.freeze([
    "numeral",
    "numeral",
    "text-left",
    "text-left",
  ]),
});

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

export function collectRtlSources(projectRoot = PROJECT_ROOT) {
  const sources = {};
  const srcRoot = path.join(projectRoot, "src");
  for (const absolute of walk(srcRoot)) {
    const relative = path
      .relative(projectRoot, absolute)
      .split(path.sep)
      .join("/");
    if (
      /\.(?:ts|tsx|css)$/.test(relative) &&
      !/\.(?:test|spec)\.[^.]+$/.test(relative)
    ) {
      sources[relative] = fs.readFileSync(absolute, "utf8");
    }
  }
  for (const relative of ["index.html", "src/main.tsx", "src/index.css"]) {
    sources[relative] = fs.readFileSync(path.join(projectRoot, relative), "utf8");
  }
  return sources;
}

function parse(fileName, source) {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const diagnostics = file.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    throw new Error(`RTL policy cannot parse ${fileName}`);
  }
  return file;
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function classAttributeText(attributes) {
  const attribute = attributes.properties.find(
    (property) =>
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === "className",
  );
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) {
    return null;
  }
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression
  ) {
    return literalText(attribute.initializer.expression);
  }
  return null;
}

function styleAttributeExpression(attributes) {
  const attribute = attributes.properties.find(
    (property) =>
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === "style",
  );
  if (
    !attribute ||
    !ts.isJsxAttribute(attribute) ||
    !attribute.initializer ||
    !ts.isJsxExpression(attribute.initializer) ||
    !attribute.initializer.expression
  ) {
    return null;
  }
  return attribute.initializer.expression;
}

function collectVariableInitializers(file) {
  const initializers = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const current = initializers.get(node.name.text) ?? [];
      current.push(node.initializer);
      initializers.set(node.name.text, current);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return initializers;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function resolveStyleObjects(fileName, expression, initializers, resolving = new Set()) {
  const current = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(current)) return [current];
  if (
    ts.isIdentifier(current) &&
    (current.text === "undefined" || current.text === "null")
  ) {
    return [];
  }
  if (current.kind === ts.SyntaxKind.NullKeyword) return [];
  if (ts.isConditionalExpression(current)) {
    return [
      ...resolveStyleObjects(fileName, current.whenTrue, initializers, resolving),
      ...resolveStyleObjects(fileName, current.whenFalse, initializers, resolving),
    ];
  }
  if (
    ts.isBinaryExpression(current) &&
    (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [
      ...resolveStyleObjects(fileName, current.left, initializers, resolving),
      ...resolveStyleObjects(fileName, current.right, initializers, resolving),
    ];
  }
  if (ts.isIdentifier(current)) {
    const candidates = initializers.get(current.text) ?? [];
    if (candidates.length !== 1 || resolving.has(current.text)) {
      throw new Error(
        `${fileName} inline style expression ${current.text} is not uniquely resolvable`,
      );
    }
    const nextResolving = new Set(resolving);
    nextResolving.add(current.text);
    return resolveStyleObjects(
      fileName,
      candidates[0],
      initializers,
      nextResolving,
    );
  }
  throw new Error(`${fileName} inline style must be statically resolvable`);
}

function propertyNameText(fileName, file, property) {
  if (ts.isComputedPropertyName(property.name)) {
    const computed = literalText(property.name.expression);
    if (computed === null) {
      throw new Error(
        `${fileName} inline style computed property is not statically resolvable`,
      );
    }
    return computed;
  }
  return property.name.getText(file).replace(/["']/g, "");
}

function assertStyleObjectsUseLogicalProperties(
  fileName,
  file,
  objects,
  initializers,
) {
  const inspect = (object) => {
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        for (const spread of resolveStyleObjects(
          fileName,
          property.expression,
          initializers,
        )) {
          inspect(spread);
        }
        continue;
      }
      if (
        !ts.isPropertyAssignment(property) &&
        !ts.isShorthandPropertyAssignment(property)
      ) {
        throw new Error(`${fileName} inline style property is not declarative`);
      }
      const propertyName = propertyNameText(fileName, file, property);
      if (
        /^(?:margin|padding)(?:Left|Right)$/.test(propertyName) ||
        /^border(?:Left|Right)(?:Width|Style|Color)?$/.test(propertyName) ||
        /^border(?:Top|Bottom)(?:Left|Right)Radius$/.test(propertyName) ||
        propertyName === "left" ||
        propertyName === "right"
      ) {
        throw new Error(
          `${fileName} inline style must use a logical-direction property`,
        );
      }
      if (
        propertyName === "textAlign" &&
        ts.isPropertyAssignment(property) &&
        literalText(property.initializer)?.match(/^(?:left|right)$/)
      ) {
        throw new Error(`${fileName} inline textAlign must be logical`);
      }
    }
  };
  for (const object of objects) inspect(object);
}

function utilityBase(token) {
  return token.slice(token.lastIndexOf(":") + 1);
}

function isPhysicalUtility(token) {
  const base = utilityBase(token);
  return /^(?:-?(?:ml|mr|pl|pr)-.+|-?(?:left|right)-.+|border-(?:l|r)(?:-.+)?|text-(?:left|right)|rounded-(?:l|r)(?:-.+)?|float-(?:left|right)|clear-(?:left|right)|space-x(?:-.+)?|divide-x(?:-.+)?)$/.test(
    base,
  );
}

function isUnqualifiedHorizontalTranslation(token) {
  const base = utilityBase(token);
  if (!/^-?translate-x-(?!0(?:$|\/))/.test(base)) return false;
  const variants = token.slice(0, token.length - base.length).split(":");
  return !variants.includes("ltr") && !variants.includes("rtl");
}

function addResidual(residuals, fileName, token) {
  const current = residuals.get(fileName) ?? [];
  current.push(token);
  residuals.set(fileName, current);
}

function scanTypeScript(fileName, source, residuals) {
  const file = parse(fileName, source);
  const initializers = collectVariableInitializers(file);
  const visit = (node) => {
    const text = literalText(node);
    if (text !== null) {
      const tokens = text.split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        if (isPhysicalUtility(token)) {
          addResidual(residuals, fileName, utilityBase(token));
        }
        if (isUnqualifiedHorizontalTranslation(token)) {
          addResidual(residuals, fileName, utilityBase(token));
        }
      }
      const hasNumericTypography = tokens.some(
        (token) => token === "tabular-nums" || token === "numeral",
      );
      if (hasNumericTypography && !tokens.includes("bidi-number")) {
        for (const token of tokens) {
          if (token === "tabular-nums" || token === "numeral") {
            addResidual(residuals, fileName, token);
          }
        }
      }
    }

    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const name = ts.isIdentifier(node.tagName) ? node.tagName.text : null;
      if (name && DIRECTIONAL_ICONS.has(name)) {
        const classes = classAttributeText(node.attributes);
        if (!classes?.split(/\s+/).includes("rtl:-scale-x-100")) {
          throw new Error(
            `${fileName} ${name} must mirror with literal rtl:-scale-x-100`,
          );
        }
      }
      const style = styleAttributeExpression(node.attributes);
      if (style) {
        assertStyleObjectsUseLogicalProperties(
          fileName,
          file,
          resolveStyleObjects(fileName, style, initializers),
          initializers,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

function assertCssUsesLogicalProperties(fileName, source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const physicalProperty =
    /(?:^|[;{]\s*)(?:(?:margin|padding|border(?:-width|-style|-color)?)-(?:left|right)|left|right)\s*:/m;
  const physicalValue =
    /(?:^|[;{]\s*)(?:text-align|float|clear)\s*:\s*(?:left|right)\b/m;
  if (
    physicalProperty.test(withoutComments) ||
    physicalValue.test(withoutComments)
  ) {
    throw new Error(`${fileName} contains a physical-direction CSS declaration`);
  }
}

function assertExactChatResiduals(residuals) {
  const expectedFiles = Object.keys(CHAT_OWNED_RESIDUALS).sort();
  const actualFiles = [...residuals.keys()].sort();
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((fileName, index) => fileName !== expectedFiles[index])
  ) {
    throw new Error(
      `RTL residual paths changed\nexpected: ${expectedFiles.join(", ")}\nactual: ${actualFiles.join(", ")}`,
    );
  }
  for (const fileName of expectedFiles) {
    const expected = [...CHAT_OWNED_RESIDUALS[fileName]].sort();
    const actual = [...(residuals.get(fileName) ?? [])].sort();
    if (
      actual.length !== expected.length ||
      actual.some((token, index) => token !== expected[index])
    ) {
      throw new Error(
        `${fileName} RTL residuals changed\nexpected: ${expected.join(", ")}\nactual: ${actual.join(", ")}`,
      );
    }
  }
}

function assertBootstrapContracts(sources) {
  const html = sources["index.html"];
  const main = sources["src/main.tsx"];
  const css = sources["src/index.css"];
  if (!html || !/<html\s+lang="en"\s+dir="ltr"\s+class="dark">/.test(html)) {
    throw new Error("index.html must declare the reviewed lang=en dir=ltr baseline");
  }
  const mainFile = main ? parse("src/main.tsx", main) : null;
  const directionImports = mainFile?.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./lib/document-direction" &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.length === 1 &&
      statement.importClause.namedBindings.elements[0].name.text ===
        "installDocumentDirection",
  );
  const directionCalls = mainFile?.statements.filter(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) &&
      statement.expression.expression.text === "installDocumentDirection" &&
      statement.expression.arguments.length === 0,
  );
  const rootRenderCalls = mainFile?.statements.filter(
    (statement) => {
      if (
        !ts.isExpressionStatement(statement) ||
        !ts.isCallExpression(statement.expression) ||
        !ts.isPropertyAccessExpression(statement.expression.expression) ||
        statement.expression.expression.name.text !== "render"
      ) {
        return false;
      }
      const createRoot = statement.expression.expression.expression;
      return (
        ts.isCallExpression(createRoot) &&
        ts.isPropertyAccessExpression(createRoot.expression) &&
        ts.isIdentifier(createRoot.expression.expression) &&
        createRoot.expression.expression.text === "ReactDOM" &&
        createRoot.expression.name.text === "createRoot"
      );
    },
  );
  if (
    directionImports?.length !== 1 ||
    directionCalls?.length !== 1 ||
    rootRenderCalls?.length !== 1 ||
    mainFile.statements.indexOf(directionCalls[0]) >=
      mainFile.statements.indexOf(rootRenderCalls[0])
  ) {
    throw new Error("main.tsx must install document direction before rendering");
  }
  const numberRule = css?.match(/\.bidi-number\s*{([^}]*)}/)?.[1] ?? "";
  if (
    !/\bdirection\s*:\s*ltr\s*;/.test(numberRule) ||
    !/\bunicode-bidi\s*:\s*isolate\s*;/.test(numberRule)
  ) {
    throw new Error(
      ".bidi-number must enforce direction:ltr and unicode-bidi:isolate",
    );
  }
}

/**
 * Fail closed over every production source. The only accepted violations are
 * the exact, counted messaging residuals above, which belong to the parallel
 * chat implementation and therefore cannot turn into a broad path exclusion.
 */
export function assertRtlSourcePolicy(sources) {
  assertBootstrapContracts(sources);
  const residuals = new Map();
  for (const [fileName, source] of Object.entries(sources)) {
    if (/\.tsx?$/.test(fileName)) scanTypeScript(fileName, source, residuals);
    if (/\.css$/.test(fileName)) assertCssUsesLogicalProperties(fileName, source);
  }
  assertExactChatResiduals(residuals);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  assertRtlSourcePolicy(collectRtlSources());
  console.log("RTL source policy: OK");
}
