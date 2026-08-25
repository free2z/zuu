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
  "Send",
]);

const REQUIRED_DIRECTIONAL_TRANSFORMS = Object.freeze({
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
  "src/features/profile/LinkedAccounts.tsx": Object.freeze({
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

function addResidual(residuals, fileName, token) {
  const current = residuals.get(fileName) ?? [];
  current.push(token);
  residuals.set(fileName, current);
}

function scanTypeScript(fileName, source, residuals) {
  const file = parse(fileName, source);
  const declarations = collectVariableDeclarations(file);
  const localBindings = collectLocalBindings(file);
  const lucideBindings = collectLucideBindings(file);
  const requiredTransform = REQUIRED_DIRECTIONAL_TRANSFORMS[fileName];
  let requiredTransformMatches = 0;
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
      const icon = directionalIcon(node.tagName, lucideBindings, localBindings);
      if (icon && !Object.hasOwn(CHAT_OWNED_RESIDUALS, fileName)) {
        const classes = classAttributeText(node.attributes);
        if (!classes?.split(/\s+/).includes("rtl:-scale-x-100")) {
          throw new Error(
            `${fileName} ${node.tagName.getText(file)} (${icon}) must mirror with literal rtl:-scale-x-100`,
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

function physicalShorthandIsDirectionNeutral(property, value) {
  return property === "border-image" || property === "mask-border"
    ? imageBorderShorthandIsDirectionNeutral(value)
    : shorthandIsDirectionNeutral(property, value);
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
  for (const { property, value } of cssDeclarations(withoutComments)) {
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
      !physicalShorthandIsDirectionNeutral(canonicalProperty, value)
    ) {
      throw new Error(`${fileName} contains an asymmetric physical CSS shorthand`);
    }
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
