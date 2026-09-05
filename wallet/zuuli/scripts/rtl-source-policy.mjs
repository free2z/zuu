//
// The RTL/bidi source policy, for every wallet surface that renders UI chrome.
//
// This is one checker parameterised by surface, not a checker per app, in the
// shape `surface-capability-authority.mjs` already uses: a `SURFACES` list of
// reviewed contracts, walked by a single CLI entrypoint. #912 already opened a
// duplication drift window by copying the Markdown/RemoteMedia components; a
// second copy of an 1100-line AST policy would be a worse one, because the two
// copies would diverge silently in exactly the direction that weakens them.
//
// Each surface carries only what is genuinely its own — the reviewed residual
// inventory and the reviewed directional-transform sites, both keyed by paths
// relative to that surface's project root. Everything else (physical Tailwind
// utilities, physical CSS declarations and shorthands, inline styles,
// directional Lucide icons, numeric bidi isolation, and the document-direction
// bootstrap) is the same property everywhere and is asserted from one body of
// code.
//
// Usage:
//   node wallet/zuuli/scripts/rtl-source-policy.mjs
//   node --test wallet/zuuli/scripts/rtl-source-policy.node-test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const WALLET_ROOT = path.resolve(SCRIPT_DIR, "../..");

const DIRECTIONAL_ICONS = new Set([
  "ArrowDownLeft",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUpRight",
  "LogIn",
  "LogOut",
  "Reply",
  "Send",
]);

/// ZUULI's reviewed direction-sensitive translation sites. Keyed by path
/// relative to `wallet/zuuli`, so a surface that has no such site simply has an
/// empty table rather than an exemption.
const ZUULI_REQUIRED_DIRECTIONAL_TRANSFORMS = Object.freeze({
  "src/components/ui/switch.tsx": Object.freeze({
    anchors: Object.freeze(["data-[state=unchecked]:translate-x-0", "h-5", "w-5"]),
    ltr: "ltr:data-[state=checked]:translate-x-5",
    rtl: "rtl:data-[state=checked]:-translate-x-5",
  }),
  "src/features/auth/ZcashLoginFlow.tsx": Object.freeze({
    anchors: Object.freeze(["absolute", "start-4", "top-9", "w-px"]),
    ltr: "ltr:-translate-x-1/2",
    rtl: "rtl:translate-x-1/2",
  }),
});

const FOUR_SIDE_SHORTHANDS = new Set([
  "margin",
  "padding",
  "inset",
  "border-width",
  "border-style",
  "border-color",
  "scroll-margin",
  "scroll-padding",
  "border-image-width",
  "border-image-outset",
  "border-image-slice",
  "mask-border-width",
  "mask-border-outset",
  "mask-border-slice",
]);

const REACT_PHYSICAL_SHORTHANDS = new Map([
  ["margin", "margin"],
  ["padding", "padding"],
  ["inset", "inset"],
  ["borderWidth", "border-width"],
  ["borderStyle", "border-style"],
  ["borderColor", "border-color"],
  ["scrollMargin", "scroll-margin"],
  ["scrollPadding", "scroll-padding"],
  ["borderImageWidth", "border-image-width"],
  ["borderImageOutset", "border-image-outset"],
  ["borderImageSlice", "border-image-slice"],
  ["maskBorderWidth", "mask-border-width"],
  ["maskBorderOutset", "mask-border-outset"],
  ["maskBorderSlice", "mask-border-slice"],
  ["borderRadius", "border-radius"],
  ["borderImage", "border-image"],
  ["maskBorder", "mask-border"],
]);

// The reviewed residual inventory, and it is now empty.
//
// It held exactly the messaging screens' physical-direction residuals, because
// messaging was owned by the parallel E2EE effort. #904 phase 3 moved that
// surface to `wallet/e2e2z`, so ZUULI has no residual left and this policy is
// strictly stricter than it was: any residual, in any file, now fails.
//
// It stays an exact inventory rather than a directory exemption. Emptying it is
// not the same as deleting the mechanism — the next surface that needs a
// counted exception gets counted, not excluded.
export const CHAT_OWNED_RESIDUALS = Object.freeze({});

/// e2e2z's reviewed residual inventory, and it is empty too.
///
/// The messaging screens arrived here from ZUULI in #904 phase 3 carrying
/// residuals that ZUULI had counted for them. They do not keep that exemption:
/// #917 fixed the residuals at the source instead, so the surface that renders
/// user-authored text next to identity chrome is held to the whole policy with
/// nothing excused. Chat is where bidi handling matters most — a `U+202E` in a
/// message body reorders the chrome around it — so an exemption here would be
/// the worst-placed one in the tree.
export const E2E2Z_OWNED_RESIDUALS = Object.freeze({});

/**
 * The reviewed contract, per surface. `directory` is relative to `wallet/`.
 *
 * `wallet/free2z` is deliberately absent: it is a separate surface with its own
 * component tree, and bringing it under this policy is its own change with its
 * own residual review, not a line added here. `wallet/zuuallet` is likewise
 * absent — it is the reference wallet, not a shipped locale surface.
 */
export const SURFACES = Object.freeze([
  Object.freeze({
    directory: "zuuli",
    reviewedResiduals: CHAT_OWNED_RESIDUALS,
    requiredDirectionalTransforms: ZUULI_REQUIRED_DIRECTIONAL_TRANSFORMS,
  }),
  Object.freeze({
    directory: "e2e2z",
    reviewedResiduals: E2E2Z_OWNED_RESIDUALS,
    requiredDirectionalTransforms: Object.freeze({}),
  }),
]);

const ZUULI_SURFACE = SURFACES[0];

export function surfaceProjectRoot(surface) {
  return path.join(WALLET_ROOT, surface.directory);
}

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

function effectiveJsxAttribute(attributes, name) {
  let effective = null;
  for (const property of attributes.properties) {
    if (ts.isJsxSpreadAttribute(property)) {
      effective = null;
      continue;
    }
    if (
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name
    ) {
      effective = property;
    }
  }
  return effective;
}

function classAttributeText(attributes) {
  const attribute = effectiveJsxAttribute(attributes, "className");
  if (!attribute?.initializer) {
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
  const attribute = effectiveJsxAttribute(attributes, "style");
  if (
    !attribute ||
    !attribute.initializer ||
    !ts.isJsxExpression(attribute.initializer) ||
    !attribute.initializer.expression
  ) {
    return null;
  }
  return attribute.initializer.expression;
}

function collectVariableDeclarations(file) {
  const declarations = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const current = declarations.get(node.name.text) ?? [];
      current.push(node);
      declarations.set(node.name.text, current);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return declarations;
}

function collectLocalBindings(file) {
  const bindings = new Map();
  const add = (name, declaration) => {
    if (!name) return;
    const current = bindings.get(name.text) ?? [];
    current.push(declaration);
    bindings.set(name.text, current);
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      if (ts.isIdentifier(node.name)) add(node.name, node);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      add(node.name, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return bindings;
}

function lexicalScope(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isSourceFile(current) ||
      ts.isBlock(current) ||
      ts.isModuleBlock(current) ||
      ts.isCaseBlock(current) ||
      ts.isFunctionLike(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function scopeDepth(scope) {
  let depth = 0;
  for (let current = scope; current; current = current.parent) depth += 1;
  return depth;
}

function resolveVariableDeclaration(identifier, declarations) {
  const candidates = (declarations.get(identifier.text) ?? [])
    .map((declaration) => ({ declaration, scope: lexicalScope(declaration) }))
    .filter(
      ({ declaration, scope }) =>
        scope &&
        declaration.pos < identifier.pos &&
        scope.pos <= identifier.pos &&
        identifier.end <= scope.end,
    )
    .sort(
      (left, right) =>
        scopeDepth(right.scope) - scopeDepth(left.scope) ||
        right.declaration.pos - left.declaration.pos,
    );
  return candidates[0]?.declaration ?? null;
}

function hasLexicalShadow(identifier, bindings) {
  return Boolean(resolveVariableDeclaration(identifier, bindings));
}

function collectLucideBindings(file) {
  const named = new Map();
  const namespaces = new Set();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      literalText(statement.moduleSpecifier) !== "lucide-react" ||
      !statement.importClause?.namedBindings
    ) {
      continue;
    }
    const bindings = statement.importClause.namedBindings;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (DIRECTIONAL_ICONS.has(importedName)) {
        named.set(element.name.text, importedName);
      }
    }
  }
  return { named, namespaces };
}

function directionalIcon(tagName, bindings, localBindings) {
  if (ts.isIdentifier(tagName)) {
    if (hasLexicalShadow(tagName, localBindings)) return null;
    return bindings.named.get(tagName.text) ?? null;
  }
  if (
    ts.isPropertyAccessExpression(tagName) &&
    ts.isIdentifier(tagName.expression) &&
    !hasLexicalShadow(tagName.expression, localBindings) &&
    bindings.namespaces.has(tagName.expression.text) &&
    DIRECTIONAL_ICONS.has(tagName.name.text)
  ) {
    return tagName.name.text;
  }
  return null;
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

function resolveStyleObjects(fileName, expression, declarations, resolving = new Set()) {
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
      ...resolveStyleObjects(fileName, current.whenTrue, declarations, resolving),
      ...resolveStyleObjects(fileName, current.whenFalse, declarations, resolving),
    ];
  }
  if (
    ts.isBinaryExpression(current) &&
    (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [
      ...resolveStyleObjects(fileName, current.left, declarations, resolving),
      ...resolveStyleObjects(fileName, current.right, declarations, resolving),
    ];
  }
  if (ts.isIdentifier(current)) {
    const declaration = resolveVariableDeclaration(current, declarations);
    if (!declaration || resolving.has(declaration)) {
      throw new Error(
        `${fileName} inline style expression ${current.text} is not lexically resolvable`,
      );
    }
    const nextResolving = new Set(resolving);
    nextResolving.add(declaration);
    return resolveStyleObjects(
      fileName,
      declaration.initializer,
      declarations,
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
  declarations,
) {
  const resolveStaticStrings = (expression, resolving = new Set()) => {
    const current = unwrapExpression(expression);
    const literal = literalText(current);
    if (literal !== null) return [literal];
    if (ts.isNumericLiteral(current)) return [current.text];
    if (ts.isConditionalExpression(current)) {
      return [
        ...resolveStaticStrings(current.whenTrue, resolving),
        ...resolveStaticStrings(current.whenFalse, resolving),
      ];
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return [
        ...resolveStaticStrings(current.left, resolving),
        ...resolveStaticStrings(current.right, resolving),
      ];
    }
    if (ts.isIdentifier(current)) {
      const declaration = resolveVariableDeclaration(current, declarations);
      if (!declaration || resolving.has(declaration)) {
        throw new Error(
          `${fileName} inline style value ${current.text} is not lexically resolvable`,
        );
      }
      const nextResolving = new Set(resolving);
      nextResolving.add(declaration);
      return resolveStaticStrings(declaration.initializer, nextResolving);
    }
    throw new Error(`${fileName} inline style value is not statically resolvable`);
  };
  const inspect = (object) => {
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        for (const spread of resolveStyleObjects(
          fileName,
          property.expression,
          declarations,
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
        resolveStaticStrings(
          ts.isPropertyAssignment(property) ? property.initializer : property.name,
        ).some((value) =>
          /^(?:left|right)$/i.test(value),
        )
      ) {
        throw new Error(`${fileName} inline textAlign must be logical`);
      }
      const shorthand = REACT_PHYSICAL_SHORTHANDS.get(propertyName);
      if (
        shorthand &&
        resolveStaticStrings(
          ts.isPropertyAssignment(property) ? property.initializer : property.name,
        ).some((value) => !physicalShorthandIsDirectionNeutral(shorthand, value))
      ) {
        throw new Error(
          `${fileName} inline style contains an asymmetric physical shorthand`,
        );
      }
    }
  };
  for (const object of objects) inspect(object);
}

function styleObjectsOverrideDirectionalTransform(
  fileName,
  file,
  objects,
  declarations,
) {
  const inspect = (object) => object.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) {
      return resolveStyleObjects(
        fileName,
        property.expression,
        declarations,
      ).some(inspect);
    }
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      return true;
    }
    return ["transform", "translate", "scale"].includes(
      propertyNameText(fileName, file, property),
    );
  });
  return objects.some(inspect);
}

function utilityBase(token) {
  return splitVariants(token).at(-1) ?? "";
}

function isPhysicalUtility(token) {
  const base = utilityBase(token).toLowerCase();
  const arbitrary = /^\[([\w-]+):(.+)\]$/.exec(base);
  if (arbitrary) {
    const [, property, value] = arbitrary;
    const normalizedValue = value.replaceAll("_", " ");
    return (
      isPhysicalCssProperty(property) ||
      isPhysicalCssValue(property, normalizedValue) ||
      ((FOUR_SIDE_SHORTHANDS.has(property) ||
        property === "border-radius" ||
        property === "border-image" ||
        property === "mask-border") &&
        !physicalShorthandIsDirectionNeutral(property, normalizedValue))
    );
  }
  return /^(?:-?(?:ml|mr|pl|pr)-.+|-?(?:left|right)-.+|border-(?:l|r)(?:-.+)?|text-(?:left|right)|rounded-(?:l|r|tl|tr|bl|br)(?:-.+)?|float-(?:left|right)|clear-(?:left|right)|space-x(?:-.+)?|divide-x(?:-.+)?)$/.test(
    base,
  );
}

function splitVariants(token) {
  const parts = [];
  let start = 0;
  let squareDepth = 0;
  let roundDepth = 0;
  for (let index = 0; index < token.length; index += 1) {
    const character = token[index];
    if (character === "[") squareDepth += 1;
    else if (character === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (character === "(") roundDepth += 1;
    else if (character === ")") roundDepth = Math.max(0, roundDepth - 1);
    else if (character === ":" && squareDepth === 0 && roundDepth === 0) {
      parts.push(token.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(token.slice(start));
  return parts;
}

function isUnqualifiedHorizontalTranslation(token) {
  const base = utilityBase(token);
  if (!/^-?translate-x-(?!0(?:$|\/))/.test(base)) return false;
  const variants = splitVariants(token).slice(0, -1);
  return !variants.includes("ltr") && !variants.includes("rtl");
}

function assertPairedDirectionalTranslations(fileName, tokens) {
  const translations = tokens.flatMap((token) => {
    const parts = splitVariants(token);
    const base = parts.at(-1) ?? "";
    if (!/^-?translate-x-(?!0(?:$|\/))/.test(base)) return [];
    const direction = parts.includes("ltr")
      ? "ltr"
      : parts.includes("rtl")
        ? "rtl"
        : null;
    if (!direction) return [];
    return [{
      direction,
      variants: parts.slice(0, -1).filter((part) => part !== "ltr" && part !== "rtl"),
      magnitude: base.replace(/^-/, ""),
      negative: base.startsWith("-"),
      token,
    }];
  });
  for (const translation of translations) {
    const counterpart = translations.find(
      (candidate) =>
        candidate.direction !== translation.direction &&
        candidate.magnitude === translation.magnitude &&
        candidate.negative !== translation.negative &&
        JSON.stringify(candidate.variants) === JSON.stringify(translation.variants),
    );
    if (!counterpart) {
      throw new Error(
        `${fileName} directional translation ${translation.token} must have an exact opposite-sign LTR/RTL pair`,
      );
    }
  }
}

function classAttributeTokens(attributes) {
  const attribute = effectiveJsxAttribute(attributes, "className");
  if (!attribute?.initializer) return [];
  const texts = [];
  const visit = (node) => {
    const text = literalText(node);
    if (text !== null) texts.push(text);
    else ts.forEachChild(node, visit);
  };
  visit(attribute.initializer);
  return texts.flatMap((text) => text.split(/\s+/).filter(Boolean));
}

/**
 * Record one residual, with the line it sits on.
 *
 * The reviewed inventory is compared on `token` alone — a counted exception
 * must not churn every time a file gains a line above it — but the failure
 * message quotes `file:line`, because a residual reported as a bare token is a
 * grep the reader has to run themselves.
 */
function addResidual(residuals, fileName, token, line) {
  const current = residuals.get(fileName) ?? [];
  current.push({ token, line });
  residuals.set(fileName, current);
}

function describeResiduals(entries) {
  return [...entries]
    .sort((left, right) => left.line - right.line || (left.token < right.token ? -1 : 1))
    .map(({ token, line }) => `${token}@${line}`)
    .join(", ");
}

function scanTypeScript(fileName, source, residuals, surface) {
  const file = parse(fileName, source);
  const declarations = collectVariableDeclarations(file);
  const localBindings = collectLocalBindings(file);
  const lucideBindings = collectLucideBindings(file);
  const requiredTransform = surface.requiredDirectionalTransforms[fileName];
  let requiredTransformMatches = 0;
  const visit = (node) => {
    const text = literalText(node);
    if (text !== null) {
      const line =
        file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      const tokens = text.split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        if (isPhysicalUtility(token)) {
          addResidual(residuals, fileName, utilityBase(token), line);
        }
        if (isUnqualifiedHorizontalTranslation(token)) {
          addResidual(residuals, fileName, utilityBase(token), line);
        }
      }
      const hasNumericTypography = tokens.some(
        (token) => token === "tabular-nums" || token === "numeral",
      );
      if (hasNumericTypography && !tokens.includes("bidi-number")) {
        for (const token of tokens) {
          if (token === "tabular-nums" || token === "numeral") {
            addResidual(residuals, fileName, token, line);
          }
        }
      }
    }

    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const icon = directionalIcon(node.tagName, lucideBindings, localBindings);
      if (icon && !Object.hasOwn(surface.reviewedResiduals, fileName)) {
        const classes = classAttributeText(node.attributes);
        if (!classes?.split(/\s+/).includes("rtl:-scale-x-100")) {
          const line =
            file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
          throw new Error(
            `${fileName}:${line} ${node.tagName.getText(file)} (${icon}) must mirror with literal rtl:-scale-x-100`,
          );
        }
      }
      const classTokens = classAttributeTokens(node.attributes);
      assertPairedDirectionalTranslations(fileName, classTokens);
      const hasDirectionalTransform =
        icon !== null ||
        classTokens.some((token) =>
          /^(?:ltr|rtl):(?:(?:data-\[[^\]]+\]:)?-?(?:translate-x|scale-x)-)/.test(
            token,
          ),
        );
      if (
        requiredTransform &&
        requiredTransform.anchors.every((token) => classTokens.includes(token))
      ) {
        requiredTransformMatches += 1;
        if (
          !classTokens.includes(requiredTransform.ltr) ||
          !classTokens.includes(requiredTransform.rtl)
        ) {
          throw new Error(
            `${fileName} reviewed directional transform must retain exact opposite-sign LTR and RTL tokens`,
          );
        }
      }
      const style = styleAttributeExpression(node.attributes);
      if (style) {
        const styleObjects = resolveStyleObjects(fileName, style, declarations);
        assertStyleObjectsUseLogicalProperties(
          fileName,
          file,
          styleObjects,
          declarations,
        );
        if (
          hasDirectionalTransform &&
          styleObjectsOverrideDirectionalTransform(
            fileName,
            file,
            styleObjects,
            declarations,
          )
        ) {
          throw new Error(
            `${fileName} ${node.tagName.getText(file)} inline style must not override its directional transform`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (requiredTransform && requiredTransformMatches !== 1) {
    throw new Error(
      `${fileName} must contain exactly one reviewed directional transform site`,
    );
  }
}

function cssValueTokens(value) {
  const tokens = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      current += character;
      if (character === "\\") current += value[++index] ?? "";
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
    } else if (character === "(" || character === "[") {
      depth += 1;
      current += character;
    } else if (character === ")" || character === "]") {
      depth = Math.max(0, depth - 1);
      current += character;
    } else if (/\s/.test(character) && depth === 0) {
      if (current) tokens.push(current);
      current = "";
    } else if (character === "/" && depth === 0) {
      if (current) tokens.push(current);
      tokens.push("/");
      current = "";
    } else {
      current += character;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function cssDeclarations(source) {
  const declarations = [];
  const pattern = /(?:^|[;{])\s*([\w-]+)\s*:/gm;
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 0;
    let quote = null;
    let end = start;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (quote) {
        if (character === "\\") end += 1;
        else if (character === quote) quote = null;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === "(" || character === "[") depth += 1;
      else if (character === ")" || character === "]") depth = Math.max(0, depth - 1);
      else if ((character === ";" || character === "}") && depth === 0) break;
    }
    declarations.push({ property: match[1], value: source.slice(start, end).trim() });
  }
  return declarations;
}

function shorthandIsDirectionNeutral(property, value) {
  const tokens = cssValueTokens(value).filter(
    (token) =>
      token.toLowerCase() !== "!important" &&
      (!property.endsWith("-slice") || token.toLowerCase() !== "fill"),
  );
  const groups = [[]];
  for (const token of tokens) {
    if (property === "border-radius" && token === "/") groups.push([]);
    else groups.at(-1).push(token);
  }
  return groups.every((tokens) => {
    if (tokens.length <= 1) return true;
    if (FOUR_SIDE_SHORTHANDS.has(property)) {
      return tokens.length < 4 || tokens[1] === tokens[3];
    }
    const corners = tokens.length === 2
      ? [tokens[0], tokens[1], tokens[0], tokens[1]]
      : tokens.length === 3
        ? [tokens[0], tokens[1], tokens[2], tokens[1]]
        : tokens.slice(0, 4);
    return corners.length === 4 && corners[0] === corners[1] && corners[2] === corners[3];
  });
}

function imageBorderShorthandIsDirectionNeutral(value) {
  const tokens = cssValueTokens(value).filter(
    (token) => token.toLowerCase() !== "!important",
  );
  const firstSlash = tokens.indexOf("/");
  if (firstSlash < 0) return true;
  const secondSlash = tokens.indexOf("/", firstSlash + 1);
  const repeatKeywords = new Set(["stretch", "repeat", "round", "space"]);
  const end = secondSlash < 0 ? tokens.length : secondSlash;
  const widthTokens = tokens
    .slice(firstSlash + 1, end)
    .filter((token) => !repeatKeywords.has(token.toLowerCase()));
  return (
    widthTokens.length <= 3 ||
    (widthTokens.length === 4 && widthTokens[1] === widthTokens[3])
  );
}

function firstCssVarCall(value) {
  let quote = null;
  for (let index = 0; index < value.length - 3; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (value.slice(index, index + 4).toLowerCase() !== "var(") continue;
    let depth = 1;
    let innerQuote = null;
    for (let end = index + 4; end < value.length; end += 1) {
      const inner = value[end];
      if (innerQuote) {
        if (inner === "\\") end += 1;
        else if (inner === innerQuote) innerQuote = null;
      } else if (inner === '"' || inner === "'") innerQuote = inner;
      else if (inner === "(") depth += 1;
      else if (inner === ")" && --depth === 0) {
        return { start: index, end: end + 1, contents: value.slice(index + 4, end) };
      }
    }
    return null;
  }
  return null;
}

function splitCssVarArguments(contents) {
  let depth = 0;
  let quote = null;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (character === "," && depth === 0) {
      return [contents.slice(0, index).trim(), contents.slice(index + 1).trim()];
    }
  }
  return [contents.trim(), null];
}

function expandCssCustomProperties(
  value,
  customProperties,
  resolving = new Set(),
  expansionCount = { value: 0 },
) {
  if (expansionCount.value > 128) return [];
  const call = firstCssVarCall(value);
  if (!call) return [value];
  const [name, fallback] = splitCssVarArguments(call.contents);
  if (!/^--[\w-]+$/.test(name)) return [];
  let replacements = [];
  if (!resolving.has(name)) {
    const nextResolving = new Set(resolving);
    nextResolving.add(name);
    for (const definition of customProperties.get(name) ?? []) {
      replacements.push(
        ...expandCssCustomProperties(
          definition,
          customProperties,
          nextResolving,
          expansionCount,
        ),
      );
    }
  }
  if (fallback !== null) {
    replacements.push(
      ...expandCssCustomProperties(
        fallback,
        customProperties,
        resolving,
        expansionCount,
      ),
    );
  }
  const expanded = [];
  for (const replacement of replacements) {
    expansionCount.value += 1;
    expanded.push(
      ...expandCssCustomProperties(
        `${value.slice(0, call.start)}${replacement}${value.slice(call.end)}`,
        customProperties,
        resolving,
        expansionCount,
      ),
    );
  }
  return expanded;
}

function unresolvedCustomPropertyShapeIsNeutral(property, value) {
  const tokens = cssValueTokens(value).filter(
    (token) => token.toLowerCase() !== "!important",
  );
  if (property === "border-image" || property === "mask-border") {
    const firstSlash = tokens.indexOf("/");
    if (firstSlash < 0) return !/var\(/i.test(value);
    const secondSlash = tokens.indexOf("/", firstSlash + 1);
    const widthTokens = tokens.slice(
      firstSlash + 1,
      secondSlash < 0 ? tokens.length : secondSlash,
    );
    return widthTokens.length > 1 && imageBorderShorthandIsDirectionNeutral(value);
  }
  const groups = [[]];
  for (const token of tokens) {
    if (property === "border-radius" && token === "/") groups.push([]);
    else groups.at(-1).push(token);
  }
  return (
    groups.every(
      (group) =>
        group.length > 1 || !group.some((token) => /var\(/i.test(token)),
    ) && shorthandIsDirectionNeutral(property, value)
  );
}

function physicalShorthandIsDirectionNeutral(
  property,
  value,
  customProperties = new Map(),
) {
  const check = property === "border-image" || property === "mask-border"
    ? imageBorderShorthandIsDirectionNeutral
    : (candidate) => shorthandIsDirectionNeutral(property, candidate);
  if (!/var\(/i.test(value)) return check(value);
  const expanded = expandCssCustomProperties(value, customProperties);
  return expanded.length > 0
    ? expanded.every(check)
    : unresolvedCustomPropertyShapeIsNeutral(property, value);
}

function isPhysicalCssProperty(property) {
  return /^(?:(?:margin|padding)-(?:left|right)|(?:left|right)|border-(?:left|right)(?:-(?:width|style|color))?|border-(?:top|bottom)-(?:left|right)-radius)$/i.test(
    property,
  );
}

function isPhysicalCssValue(property, value) {
  if (!/^(?:text-align|float|clear)$/i.test(property)) return false;
  return /^(?:left|right)(?:\s*!important)?$/i.test(value.trim());
}

function assertCssUsesLogicalProperties(fileName, source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = cssDeclarations(withoutComments);
  const customProperties = new Map();
  for (const { property, value } of declarations) {
    if (!property.startsWith("--")) continue;
    const definitions = customProperties.get(property) ?? [];
    definitions.push(value);
    customProperties.set(property, definitions);
  }
  for (const { property, value } of declarations) {
    const canonicalProperty = property.toLowerCase();
    if (
      isPhysicalCssProperty(canonicalProperty) ||
      isPhysicalCssValue(canonicalProperty, value)
    ) {
      throw new Error(`${fileName} contains a physical-direction CSS declaration`);
    }
    if (
      (FOUR_SIDE_SHORTHANDS.has(canonicalProperty) ||
        canonicalProperty === "border-radius" ||
        canonicalProperty === "border-image" ||
        canonicalProperty === "mask-border") &&
      !physicalShorthandIsDirectionNeutral(
        canonicalProperty,
        value,
        customProperties,
      )
    ) {
      throw new Error(`${fileName} contains an asymmetric physical CSS shorthand`);
    }
  }
}

function assertExactChatResiduals(residuals, surface) {
  const expectedFiles = Object.keys(surface.reviewedResiduals).sort();
  const actualFiles = [...residuals.keys()].sort();
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((fileName, index) => fileName !== expectedFiles[index])
  ) {
    throw new Error(
      `${surface.directory}: RTL residual paths changed\nexpected: ${expectedFiles.join(", ")}\nactual: ${actualFiles
        .map((file) => `${file} (${describeResiduals(residuals.get(file) ?? [])})`)
        .join(", ")}`,
    );
  }
  for (const fileName of expectedFiles) {
    const entries = residuals.get(fileName) ?? [];
    const expected = [...surface.reviewedResiduals[fileName]].sort();
    const actual = entries.map(({ token }) => token).sort();
    if (
      actual.length !== expected.length ||
      actual.some((token, index) => token !== expected[index])
    ) {
      throw new Error(
        `${surface.directory}: ${fileName} RTL residuals changed\nexpected: ${expected.join(", ")}\nactual: ${describeResiduals(entries)}`,
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
  // Accepts both a direct `ReactDOM.createRoot(...).render(...)` statement
  // and the app-bootstrap `mountApplication({ root: ReactDOM.createRoot(...),
  // ... })` shape (optionally `void`-prefixed) — the entrypoint statement
  // just needs to actually create the root somewhere in its call tree, so
  // direction installation is provably ordered before the DOM is touched
  // regardless of which bootstrap wrapper main.tsx currently uses.
  function containsReactDomCreateRootCall(node) {
    let found = false;
    const visit = (child) => {
      if (found) return;
      if (
        ts.isCallExpression(child) &&
        ts.isPropertyAccessExpression(child.expression) &&
        ts.isIdentifier(child.expression.expression) &&
        child.expression.expression.text === "ReactDOM" &&
        child.expression.name.text === "createRoot"
      ) {
        found = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  }
  const rootRenderCalls = mainFile?.statements.filter((statement) => {
    if (!ts.isExpressionStatement(statement)) return false;
    let expression = statement.expression;
    while (ts.isVoidExpression(expression)) {
      expression = expression.expression;
    }
    return (
      ts.isCallExpression(expression) &&
      containsReactDomCreateRootCall(expression)
    );
  });
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
 * Fail closed over every production source of one surface. The only accepted
 * violations are that surface's exact, counted residuals — inventories that are
 * empty for both surfaces today, so every file is held to the whole policy.
 *
 * The surface defaults to ZUULI so the property this file has always asserted
 * keeps its original one-argument call shape.
 */
export function assertRtlSourcePolicy(sources, surface = ZUULI_SURFACE) {
  assertBootstrapContracts(sources);
  const residuals = new Map();
  for (const [fileName, source] of Object.entries(sources)) {
    if (/\.tsx?$/.test(fileName)) {
      scanTypeScript(fileName, source, residuals, surface);
    }
    if (/\.css$/.test(fileName)) assertCssUsesLogicalProperties(fileName, source);
  }
  assertExactChatResiduals(residuals, surface);
}

/** Read and judge every reviewed surface, so a new one cannot ship uncovered. */
export function assertEverySurface(surfaces = SURFACES) {
  for (const surface of surfaces) {
    assertRtlSourcePolicy(
      collectRtlSources(surfaceProjectRoot(surface)),
      surface,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  for (const surface of SURFACES) {
    assertRtlSourcePolicy(
      collectRtlSources(surfaceProjectRoot(surface)),
      surface,
    );
    console.log(`RTL source policy: ${surface.directory} OK`);
  }
}
