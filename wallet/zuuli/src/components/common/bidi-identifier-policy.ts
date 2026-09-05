import ts from "typescript";

export type BidiProductionSources = Readonly<Record<string, string>>;

interface ExpectedSite {
  functionName: string;
  value: string;
  shorten: boolean;
  head?: string;
  tail?: string;
}

const EXPECTED_SITES: Readonly<Record<string, readonly ExpectedSite[]>> = {
  "src/features/wallet/components.tsx": [
    { functionName: "AddressCard", value: "address", shorten: true },
    { functionName: "TxRow", value: "tx.txid", shorten: true },
  ],
  "src/features/wallet/History.tsx": [
    { functionName: "HistoryRow", value: "tx.txid", shorten: true },
  ],
  "src/features/wallet/Receive.tsx": [
    { functionName: "Receive", value: "address", shorten: false },
  ],
  "src/features/wallet/Send.tsx": [
    { functionName: "SendForm", value: "result.txid", shorten: true },
    { functionName: "SendForm", value: "result.txid", shorten: true },
    { functionName: "SendForm", value: "pendingSend.txid", shorten: false },
    {
      functionName: "SendForm",
      value: 'proposal.review.payments[0]?.recipient ?? ""',
      shorten: false,
    },
    { functionName: "SendForm", value: "broadcastResult.txid", shorten: false },
  ],
  "src/features/auth/ZcashLoginFlow.tsx": [
    { functionName: "ZcashLoginFlow", value: "address", shorten: true },
  ],
};

const EXPECTED_LTR_INPUTS: Readonly<Record<string, readonly string[]>> = {
  "src/features/wallet/Send.tsx": ["to"],
};

// Most policy mutants change one of the five audited files. Keep the other
// four parsed trees and their symbol tables instead of rebuilding a complete
// TypeScript program for them in every assertion. The source text is the cache
// identity, so a mutant can never inherit the verdict for the production file.
const parsedSources = new Map<string, Map<string, ts.SourceFile>>();
const sourceCheckers = new WeakMap<ts.SourceFile, ts.TypeChecker>();

function parse(fileName: string, source: string): ts.SourceFile {
  const cached = parsedSources.get(fileName)?.get(source);
  if (cached) return cached;
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const diagnostics = (
    file as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (diagnostics.length > 0) {
    throw new Error(`bidi identifier policy cannot parse ${fileName}`);
  }
  let bySource = parsedSources.get(fileName);
  if (!bySource) {
    bySource = new Map();
    parsedSources.set(fileName, bySource);
  }
  bySource.set(source, file);
  return file;
}

function stringAttribute(
  attributes: ts.JsxAttributes,
  name: string,
): string | null {
  const matches = attributes.properties.filter(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name,
  );
  if (matches.length !== 1) return null;
  const initializer = matches[0].initializer;
  return initializer && ts.isStringLiteral(initializer) ? initializer.text : null;
}

function expressionAttribute(
  file: ts.SourceFile,
  attributes: ts.JsxAttributes,
  name: string,
): string | null {
  const matches = attributes.properties.filter(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name,
  );
  if (matches.length !== 1) return null;
  const initializer = matches[0].initializer;
  if (
    !initializer ||
    !ts.isJsxExpression(initializer) ||
    !initializer.expression
  ) {
    return null;
  }
  return initializer.expression.getText(file);
}

function expressionAttributeNode(
  attributes: ts.JsxAttributes,
  name: string,
): ts.Expression | null {
  const matches = attributes.properties.filter(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name,
  );
  if (matches.length !== 1) return null;
  const initializer = matches[0].initializer;
  return initializer &&
    ts.isJsxExpression(initializer) &&
    initializer.expression
    ? initializer.expression
    : null;
}

function hasBooleanAttribute(attributes: ts.JsxAttributes, name: string): boolean {
  return attributes.properties.some(
    (property) =>
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name &&
      property.initializer === undefined,
  );
}

function enclosingFunctionName(node: ts.Node): string | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
  }
  return null;
}

function siteKey(site: ExpectedSite): string {
  return [
    site.functionName,
    site.value,
    site.shorten ? "short" : "full",
    site.head ?? "",
    site.tail ?? "",
  ].join("|");
}

function actualSiteKey(file: ts.SourceFile, node: ts.JsxSelfClosingElement): string {
  const value = expressionAttribute(file, node.attributes, "value");
  if (!value) throw new Error("BidiIdentifier must have one expression value");
  const head = expressionAttribute(file, node.attributes, "head") ?? undefined;
  const tail = expressionAttribute(file, node.attributes, "tail") ?? undefined;
  return siteKey({
    functionName: enclosingFunctionName(node) ?? "",
    value,
    shorten: hasBooleanAttribute(node.attributes, "shorten"),
    head,
    tail,
  });
}

function assertExactMultiset(fileName: string, actual: string[], expected: string[]) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (
    sortedActual.length !== sortedExpected.length ||
    sortedActual.some((value, index) => value !== sortedExpected[index])
  ) {
    throw new Error(
      `${fileName} bidi sites changed\nexpected: ${sortedExpected.join(", ")}\nactual: ${sortedActual.join(", ")}`,
    );
  }
}

function exactImportBinding(file: ts.SourceFile): ts.Identifier | null {
  const imports = file.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@/components/common/BidiIdentifier",
  );
  if (imports.length !== 1) return null;
  const clause = imports[0].importClause;
  if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    return null;
  }
  if (
    clause.namedBindings.elements.length === 1 &&
    clause.namedBindings.elements[0].name.text === "BidiIdentifier" &&
    clause.namedBindings.elements[0].propertyName === undefined
  ) {
    return clause.namedBindings.elements[0].name;
  }
  return null;
}

function checkerFor(fileName: string, file: ts.SourceFile): ts.TypeChecker {
  const cached = sourceCheckers.get(file);
  if (cached) return cached;
  const options: ts.CompilerOptions = {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) =>
    candidate === fileName
      ? file
      : getSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();
  sourceCheckers.set(file, checker);
  return checker;
}

function isImportedBidiTag(
  tagName: ts.JsxTagNameExpression,
  importBinding: ts.Identifier,
  checker: ts.TypeChecker,
): boolean {
  return (
    ts.isIdentifier(tagName) &&
    checker.getSymbolAtLocation(tagName) === checker.getSymbolAtLocation(importBinding)
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
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

type ResolutionKey = ts.Symbol | ts.Node;

function staticStringValue(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  resolving = new Set<ResolutionKey>(),
): string | null {
  const current = unwrapExpression(expression);
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return current.text;
  }
  if (!ts.isIdentifier(current)) return null;
  const symbol = checker.getSymbolAtLocation(current);
  if (!symbol || resolving.has(symbol)) return null;
  const declaration = symbol.declarations?.find(
    (candidate): candidate is ts.VariableDeclaration =>
      ts.isVariableDeclaration(candidate) && candidate.initializer !== undefined,
  );
  if (!declaration?.initializer) return null;
  const nextResolving = new Set(resolving);
  nextResolving.add(symbol);
  return staticStringValue(declaration.initializer, checker, nextResolving);
}

function staticMemberReference(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): { base: ts.Expression; name: string } | null {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return { base: current.expression, name: current.name.text };
  }
  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression
  ) {
    const name = staticStringValue(current.argumentExpression, checker);
    return name === null ? null : { base: current.expression, name };
  }
  return null;
}

function sameReference(
  left: ts.Expression,
  right: ts.Expression,
  checker: ts.TypeChecker,
  resolving = new Set<ResolutionKey>(),
): boolean {
  const actual = unwrapExpression(left);
  const expected = unwrapExpression(right);
  if (ts.isIdentifier(actual) && ts.isIdentifier(expected)) {
    const actualSymbol = checker.getSymbolAtLocation(actual);
    const expectedSymbol = checker.getSymbolAtLocation(expected);
    if (actualSymbol !== undefined && actualSymbol === expectedSymbol) return true;
    for (const [identifier, symbol, other] of [
      [actual, actualSymbol, expected],
      [expected, expectedSymbol, actual],
    ] as const) {
      if (!symbol || resolving.has(symbol)) continue;
      const declaration = symbol.declarations?.find(
        (candidate): candidate is ts.VariableDeclaration =>
          ts.isVariableDeclaration(candidate) && candidate.initializer !== undefined,
      );
      if (!declaration?.initializer) continue;
      const nextResolving = new Set(resolving);
      nextResolving.add(symbol);
      if (
        identifier === actual
          ? sameReference(declaration.initializer, other, checker, nextResolving)
          : sameReference(other, declaration.initializer, checker, nextResolving)
      ) {
        return true;
      }
    }
    return false;
  }
  const actualMember = staticMemberReference(actual, checker);
  const expectedMember = staticMemberReference(expected, checker);
  if (actualMember && expectedMember) {
    return (
      actualMember.name === expectedMember.name &&
      sameReference(actualMember.base, expectedMember.base, checker, resolving)
    );
  }
  if (
    ts.isPropertyAccessExpression(actual) &&
    ts.isPropertyAccessExpression(expected)
  ) {
    return (
      actual.name.text === expected.name.text &&
      sameReference(actual.expression, expected.expression, checker, resolving)
    );
  }
  if (
    ts.isElementAccessExpression(actual) &&
    ts.isElementAccessExpression(expected) &&
    actual.argumentExpression &&
    expected.argumentExpression
  ) {
    return (
      actual.argumentExpression.getText() === expected.argumentExpression.getText() &&
      sameReference(actual.expression, expected.expression, checker, resolving)
    );
  }
  return false;
}

function objectPropertyValues(
  expression: ts.Expression,
  propertyName: string,
  checker: ts.TypeChecker,
  resolving = new Set<ResolutionKey>(),
): ts.Expression[] {
  const current = unwrapExpression(expression);
  const member = staticMemberReference(current, checker);
  if (member) {
    if (resolving.has(current)) return [];
    const nextResolving = new Set(resolving);
    nextResolving.add(current);
    return objectPropertyValues(
      member.base,
      member.name,
      checker,
      nextResolving,
    ).flatMap((value) =>
      objectPropertyValues(value, propertyName, checker, nextResolving),
    );
  }
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || resolving.has(symbol)) return [];
    const binding = symbol.declarations?.find(ts.isBindingElement);
    if (binding) {
      const nextResolving = new Set(resolving);
      nextResolving.add(symbol);
      if (binding.dotDotDotToken && ts.isObjectBindingPattern(binding.parent)) {
        const excluded = new Set(
          binding.parent.elements
            .filter((element) => element !== binding && !element.dotDotDotToken)
            .map((element) => bindingPropertyName(element, checker))
            .filter((name): name is string => name !== null),
        );
        if (excluded.has(propertyName)) return [];
        return bindingPatternSources(
          binding.parent,
          checker,
          nextResolving,
        ).flatMap((source) =>
          objectPropertyValues(source, propertyName, checker, nextResolving),
        );
      }
      return bindingElementValues(binding, checker, nextResolving).flatMap(
        (value) =>
          objectPropertyValues(value, propertyName, checker, nextResolving),
      );
    }
    const declaration = symbol.declarations?.find(
      (candidate): candidate is ts.VariableDeclaration | ts.ParameterDeclaration =>
        (ts.isVariableDeclaration(candidate) || ts.isParameter(candidate)) &&
        candidate.initializer !== undefined,
    );
    if (!declaration?.initializer) return [];
    const nextResolving = new Set(resolving);
    nextResolving.add(symbol);
    return objectPropertyValues(
      declaration.initializer,
      propertyName,
      checker,
      nextResolving,
    );
  }
  if (!ts.isObjectLiteralExpression(current)) return [];
  for (const property of [...current.properties].reverse()) {
    if (ts.isSpreadAssignment(property)) {
      const spreadValues = objectPropertyValues(
        property.expression,
        propertyName,
        checker,
        resolving,
      );
      if (spreadValues.length > 0) return spreadValues;
      continue;
    }
    const name = property.name
      ? ts.isComputedPropertyName(property.name)
        ? staticStringValue(property.name.expression, checker)
        : property.name.text
      : null;
    if (name !== propertyName) continue;
    if (ts.isPropertyAssignment(property)) return [property.initializer];
    if (ts.isShorthandPropertyAssignment(property)) return [property.name];
    return [];
  }
  return [];
}

function arrayElementValues(
  expression: ts.Expression,
  index: number,
  checker: ts.TypeChecker,
  resolving = new Set<ResolutionKey>(),
): ts.Expression[] {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || resolving.has(symbol)) return [];
    const binding = symbol.declarations?.find(ts.isBindingElement);
    if (binding) {
      const nextResolving = new Set(resolving);
      nextResolving.add(symbol);
      if (binding.dotDotDotToken && ts.isArrayBindingPattern(binding.parent)) {
        const restIndex = binding.parent.elements.indexOf(binding);
        return restIndex < 0
          ? []
          : bindingPatternSources(
              binding.parent,
              checker,
              nextResolving,
            ).flatMap((source) =>
              arrayElementValues(
                source,
                restIndex + index,
                checker,
                nextResolving,
              ),
            );
      }
      return bindingElementValues(binding, checker, nextResolving).flatMap(
        (value) => arrayElementValues(value, index, checker, nextResolving),
      );
    }
    const declaration = symbol.declarations?.find(
      (candidate): candidate is ts.VariableDeclaration | ts.ParameterDeclaration =>
        (ts.isVariableDeclaration(candidate) || ts.isParameter(candidate)) &&
        candidate.initializer !== undefined,
    );
    if (!declaration?.initializer) return [];
    const nextResolving = new Set(resolving);
    nextResolving.add(symbol);
    return arrayElementValues(declaration.initializer, index, checker, nextResolving);
  }
  if (!ts.isArrayLiteralExpression(current)) return [];
  const element = current.elements[index];
  if (!element || ts.isOmittedExpression(element) || ts.isSpreadElement(element)) {
    return [];
  }
  return [element];
}

function bindingPropertyName(
  binding: ts.BindingElement,
  checker: ts.TypeChecker,
): string | null {
  const property = binding.propertyName ?? binding.name;
  if (ts.isComputedPropertyName(property)) {
    return staticStringValue(property.expression, checker);
  }
  return ts.isIdentifier(property) ||
    ts.isStringLiteral(property) ||
    ts.isNoSubstitutionTemplateLiteral(property)
    ? property.text
    : null;
}

function bindingPatternSources(
  pattern: ts.BindingPattern,
  checker: ts.TypeChecker,
  resolving: ReadonlySet<ResolutionKey>,
): ts.Expression[] {
  const parent = pattern.parent;
  if (ts.isVariableDeclaration(parent)) {
    return parent.initializer ? [parent.initializer] : [];
  }
  if (ts.isParameter(parent)) {
    return parent.initializer ? [parent.initializer] : [];
  }
  return ts.isBindingElement(parent)
    ? bindingElementValues(parent, checker, resolving)
    : [];
}

function bindingElementValues(
  binding: ts.BindingElement,
  checker: ts.TypeChecker,
  resolving: ReadonlySet<ResolutionKey>,
): ts.Expression[] {
  const pattern = binding.parent;
  const sources = bindingPatternSources(pattern, checker, resolving);
  if (binding.dotDotDotToken) {
    if (ts.isArrayBindingPattern(pattern)) {
      const start = pattern.elements.indexOf(binding);
      if (start < 0) return [];
      return sources.flatMap((source) =>
        arrayRestValues(source, start, checker, new Set(resolving)),
      );
    }
    const excluded = new Set(
      pattern.elements
        .filter((element) => element !== binding && !element.dotDotDotToken)
        .map((element) => bindingPropertyName(element, checker))
        .filter((name): name is string => name !== null),
    );
    return sources.flatMap((source) =>
      objectRestValues(source, excluded, checker, new Set(resolving)),
    );
  }
  let selected: ts.Expression[];
  if (ts.isObjectBindingPattern(pattern)) {
    const propertyName = bindingPropertyName(binding, checker);
    if (propertyName === null) return [];
    selected = sources.flatMap((source) =>
      objectPropertyValues(source, propertyName, checker, new Set(resolving)),
    );
  } else {
    const index = pattern.elements.indexOf(binding);
    selected = index < 0
      ? []
      : sources.flatMap((source) =>
          arrayElementValues(source, index, checker, new Set(resolving)),
        );
  }
  const defaultCanRun =
    selected.length === 0 || selected.some(expressionCanBeUndefined);
  return binding.initializer && defaultCanRun
    ? [...selected, binding.initializer]
    : selected;
}

function expressionCanBeUndefined(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression);
  if (
    ts.isStringLiteralLike(current) ||
    ts.isNumericLiteral(current) ||
    ts.isObjectLiteralExpression(current) ||
    ts.isArrayLiteralExpression(current) ||
    ts.isArrowFunction(current) ||
    ts.isFunctionExpression(current) ||
    current.kind === ts.SyntaxKind.TrueKeyword ||
    current.kind === ts.SyntaxKind.FalseKeyword ||
    current.kind === ts.SyntaxKind.NullKeyword
  ) {
    return false;
  }
  return true;
}

function arrayRestValues(
  expression: ts.Expression,
  start: number,
  checker: ts.TypeChecker,
  resolving: Set<ResolutionKey>,
): ts.Expression[] {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || resolving.has(symbol)) return [];
    const declaration = symbol.declarations?.find(
      (candidate): candidate is ts.VariableDeclaration =>
        ts.isVariableDeclaration(candidate) && candidate.initializer !== undefined,
    );
    if (!declaration?.initializer) return [];
    const nextResolving = new Set(resolving);
    nextResolving.add(symbol);
    return arrayRestValues(declaration.initializer, start, checker, nextResolving);
  }
  if (!ts.isArrayLiteralExpression(current)) return [];
  return current.elements.slice(start).flatMap((element) =>
    ts.isOmittedExpression(element)
      ? []
      : ts.isSpreadElement(element)
        ? arrayRestValues(element.expression, 0, checker, new Set(resolving))
        : [element],
  );
}

function objectRestValues(
  expression: ts.Expression,
  excluded: ReadonlySet<string>,
  checker: ts.TypeChecker,
  resolving: Set<ResolutionKey>,
): ts.Expression[] {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || resolving.has(symbol)) return [];
    const declaration = symbol.declarations?.find(
      (candidate): candidate is ts.VariableDeclaration =>
        ts.isVariableDeclaration(candidate) && candidate.initializer !== undefined,
    );
    if (!declaration?.initializer) return [];
    const nextResolving = new Set(resolving);
    nextResolving.add(symbol);
    return objectRestValues(declaration.initializer, excluded, checker, nextResolving);
  }
  if (!ts.isObjectLiteralExpression(current)) return [];
  return current.properties.flatMap((property) => {
    if (ts.isSpreadAssignment(property)) {
      return objectRestValues(
        property.expression,
        excluded,
        checker,
        new Set(resolving),
      );
    }
    const name = property.name
      ? ts.isComputedPropertyName(property.name)
        ? staticStringValue(property.name.expression, checker)
        : property.name.text
      : null;
    if (name === null || excluded.has(name)) return [];
    if (ts.isPropertyAssignment(property)) return [property.initializer];
    if (ts.isShorthandPropertyAssignment(property)) return [property.name];
    return [];
  });
}

function destructuredBindingMatchesAuditedSource(
  binding: ts.BindingElement,
  auditedSources: readonly ts.Expression[],
  checker: ts.TypeChecker,
  resolving: ReadonlySet<ResolutionKey>,
): boolean {
  const patternSources = bindingPatternSources(binding.parent, checker, resolving);
  if (ts.isObjectBindingPattern(binding.parent)) {
    const propertyName = bindingPropertyName(binding, checker);
    const directlyMatches =
      propertyName !== null &&
      patternSources.some((patternSource) =>
        auditedSources.some((source) =>
          auditedReferenceCandidates(source).some((candidate) => {
            const member = staticMemberReference(candidate, checker);
            return (
              member !== null &&
              member.name === propertyName &&
              sameReference(patternSource, member.base, checker)
            );
          }),
        ),
      );
    if (directlyMatches) return true;
  }
  return bindingElementValues(binding, checker, resolving).some((value) =>
    rendersAuditedValue(value, auditedSources, checker, new Set(resolving)),
  );
}

function auditedReferenceCandidates(expression: ts.Expression): ts.Expression[] {
  const current = unwrapExpression(expression);
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return auditedReferenceCandidates(current.left);
  }
  return [current];
}

const IDENTIFIER_DERIVING_METHODS = new Set([
  "at",
  "charAt",
  "concat",
  "join",
  "normalize",
  "padEnd",
  "padStart",
  "repeat",
  "replace",
  "replaceAll",
  "reverse",
  "slice",
  "split",
  "substr",
  "substring",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toLowerCase",
  "toString",
  "toUpperCase",
  "trim",
  "trimEnd",
  "trimStart",
]);

function exactNamedImport(
  tagName: ts.JsxTagNameExpression,
  checker: ts.TypeChecker,
  importedName: string,
  moduleName: string,
): boolean {
  if (!ts.isIdentifier(tagName)) return false;
  const symbol = checker.getSymbolAtLocation(tagName);
  return (
    symbol?.declarations?.some((declaration) => {
      if (!ts.isImportSpecifier(declaration)) return false;
      const actualImportedName = declaration.propertyName?.text ?? declaration.name.text;
      const importDeclaration = declaration.parent.parent.parent;
      return (
        actualImportedName === importedName &&
        ts.isImportDeclaration(importDeclaration) &&
        ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
        importDeclaration.moduleSpecifier.text === moduleName
      );
    }) ?? false
  );
}

function isAllowedIdentifierAttributeSink(
  attribute: ts.JsxAttribute,
  importBinding: ts.Identifier,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isIdentifier(attribute.name) || attribute.name.text !== "value") {
    return false;
  }
  const element = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) {
    return false;
  }
  if (isImportedBidiTag(element.tagName, importBinding, checker)) return true;
  return (
    exactNamedImport(element.tagName, checker, "QRCodeSVG", "qrcode.react") ||
    exactNamedImport(element.tagName, checker, "CopyButton", "./shared")
  );
}

function displayedJsxExpression(
  node: ts.JsxExpression,
  importBinding: ts.Identifier,
  checker: ts.TypeChecker,
): ts.Expression | null {
  if (!node.expression) return null;
  if (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) {
    return node.expression;
  }
  if (
    ts.isJsxAttribute(node.parent) &&
    !isAllowedIdentifierAttributeSink(node.parent, importBinding, checker)
  ) {
    return node.expression;
  }
  return null;
}

interface LocalCallable {
  callable: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;
  key: ResolutionKey;
}

function localCallables(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  resolving: ReadonlySet<ResolutionKey>,
): LocalCallable[] {
  const current = unwrapExpression(expression);
  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
    return resolving.has(current) ? [] : [{ callable: current, key: current }];
  }
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || resolving.has(symbol)) return [];
    const nextResolving = new Set(resolving);
    nextResolving.add(symbol);
    const callables: LocalCallable[] = [];
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration) && declaration.body) {
        callables.push({ callable: declaration, key: symbol });
      } else if (ts.isBindingElement(declaration)) {
        callables.push(
          ...bindingElementValues(
            declaration,
            checker,
            nextResolving,
          ).flatMap((value) =>
            localCallables(value, checker, nextResolving),
          ),
        );
      } else if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        callables.push(
          ...localCallables(declaration.initializer, checker, nextResolving),
        );
      }
    }
    return callables;
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    const argument = unwrapExpression(current.argumentExpression);
    const index = ts.isNumericLiteral(argument) ? Number(argument.text) : NaN;
    if (Number.isInteger(index) && index >= 0) {
      return arrayElementValues(
        current.expression,
        index,
        checker,
        new Set(resolving),
      ).flatMap((value) =>
        localCallables(value, checker, new Set(resolving)),
      );
    }
  }
  const member = staticMemberReference(current, checker);
  if (member) {
    return objectPropertyValues(
      member.base,
      member.name,
      checker,
      new Set(resolving),
    ).flatMap((value) =>
      localCallables(value, checker, new Set(resolving)),
    );
  }
  if (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    current.expression.name.text === "bind"
  ) {
    return localCallables(current.expression.expression, checker, resolving);
  }
  if (ts.isCallExpression(current) && current.arguments.length === 0) {
    return localCallables(current.expression, checker, resolving).flatMap(
      (local) => {
        const nextResolving = new Set(resolving);
        nextResolving.add(local.key);
        return callableReturnExpressions(local.callable).flatMap((returned) =>
          localCallables(returned, checker, nextResolving),
        );
      },
    );
  }
  if (ts.isConditionalExpression(current)) {
    return [current.whenTrue, current.whenFalse].flatMap((value) =>
      localCallables(value, checker, new Set(resolving)),
    );
  }
  if (ts.isBinaryExpression(current)) {
    if (current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return localCallables(current.right, checker, resolving);
    }
    if (
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return [current.left, current.right].flatMap((value) =>
        localCallables(value, checker, new Set(resolving)),
      );
    }
  }
  return [];
}

function callableReturnExpressions(
  callable: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
): ts.Expression[] {
  if (ts.isArrowFunction(callable) && !ts.isBlock(callable.body)) {
    return [callable.body];
  }
  if (!callable.body) return [];
  const expressions: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (node !== callable && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      expressions.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(callable.body);
  return expressions;
}

function rendersAuditedValue(
  expression: ts.Expression,
  auditedSources: readonly ts.Expression[],
  checker: ts.TypeChecker,
  resolving = new Set<ResolutionKey>(),
): boolean {
  const current = unwrapExpression(expression);
  if (
    auditedSources.some((source) =>
      auditedReferenceCandidates(source).some((candidate) =>
        sameReference(current, candidate, checker),
      ),
    )
  ) {
    return true;
  }
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || resolving.has(symbol)) return false;
    const nextResolving = new Set(resolving);
    nextResolving.add(symbol);
    const destructuredBinding = symbol.declarations?.find(ts.isBindingElement);
    if (
      destructuredBinding &&
      destructuredBindingMatchesAuditedSource(
        destructuredBinding,
        auditedSources,
        checker,
        nextResolving,
      )
    ) {
      return true;
    }
    const declaration = symbol.declarations?.find(
      (candidate): candidate is ts.VariableDeclaration =>
        ts.isVariableDeclaration(candidate) && candidate.initializer !== undefined,
    );
    const parameter = symbol.declarations?.find(
      (candidate): candidate is ts.ParameterDeclaration =>
        ts.isParameter(candidate) && candidate.initializer !== undefined,
    );
    const initializer = declaration?.initializer ?? parameter?.initializer;
    if (!initializer) return false;
    return rendersAuditedValue(
      initializer,
      auditedSources,
      checker,
      nextResolving,
    );
  }
  const member = staticMemberReference(current, checker);
  if (
    member &&
    objectPropertyValues(member.base, member.name, checker, resolving).some((value) =>
      rendersAuditedValue(value, auditedSources, checker, new Set(resolving)),
    )
  ) {
    return true;
  }
  if (ts.isTemplateExpression(current)) {
    return current.templateSpans.some((span) =>
      rendersAuditedValue(span.expression, auditedSources, checker, resolving),
    );
  }
  if (ts.isElementAccessExpression(current)) {
    const argument = current.argumentExpression
      ? unwrapExpression(current.argumentExpression)
      : null;
    const indexText = argument && ts.isNumericLiteral(argument)
      ? argument.text
      : current.argumentExpression
        ? staticStringValue(current.argumentExpression, checker)
        : null;
    const index = indexText === null ? null : Number(indexText);
    const selected = index !== null && Number.isInteger(index) && index >= 0
      ? arrayElementValues(current.expression, index, checker, resolving)
      : [];
    if (selected.length > 0) {
      return selected.some((value) =>
        rendersAuditedValue(value, auditedSources, checker, new Set(resolving)),
      );
    }
    return rendersAuditedValue(
      current.expression,
      auditedSources,
      checker,
      resolving,
    );
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.some((element) =>
      rendersAuditedValue(element, auditedSources, checker, resolving),
    );
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.some((property) => {
      if (ts.isPropertyAssignment(property)) {
        return rendersAuditedValue(
          property.initializer,
          auditedSources,
          checker,
          resolving,
        );
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const valueSymbol = checker.getShorthandAssignmentValueSymbol(property);
        if (!valueSymbol || resolving.has(valueSymbol)) return false;
        if (
          auditedSources.some((source) =>
            auditedReferenceCandidates(source).some((candidate) => {
              const reference = unwrapExpression(candidate);
              return (
                ts.isIdentifier(reference) &&
                checker.getSymbolAtLocation(reference) === valueSymbol
              );
            }),
          )
        ) {
          return true;
        }
        const declaration = valueSymbol.declarations?.find(
          (candidate): candidate is ts.VariableDeclaration =>
            ts.isVariableDeclaration(candidate) && candidate.initializer !== undefined,
        );
        if (!declaration?.initializer) return false;
        const nextResolving = new Set(resolving);
        nextResolving.add(valueSymbol);
        return rendersAuditedValue(
          declaration.initializer,
          auditedSources,
          checker,
          nextResolving,
        );
      }
      if (ts.isSpreadAssignment(property)) {
        return rendersAuditedValue(
          property.expression,
          auditedSources,
          checker,
          resolving,
        );
      }
      return false;
    });
  }
  if (ts.isSpreadElement(current)) {
    return rendersAuditedValue(
      current.expression,
      auditedSources,
      checker,
      resolving,
    );
  }
  if (ts.isCallExpression(current)) {
    if (
      ts.isPropertyAccessExpression(current.expression) &&
      IDENTIFIER_DERIVING_METHODS.has(current.expression.name.text) &&
      rendersAuditedValue(
        current.expression.expression,
        auditedSources,
        checker,
        resolving,
      )
    ) {
      return true;
    }
    if (current.arguments.length === 0) {
      for (const local of localCallables(current.expression, checker, resolving)) {
        const nextResolving = new Set(resolving);
        nextResolving.add(local.key);
        if (
          callableReturnExpressions(local.callable).some((returned) =>
            rendersAuditedValue(returned, auditedSources, checker, nextResolving),
          )
        ) {
          return true;
        }
      }
    }
    // An arbitrary helper can return or embed any argument. Treat an audited
    // identifier passed to one as a display unless the call stays inside the
    // imported BidiIdentifier boundary checked by the caller.
    return current.arguments.some((argument) =>
      rendersAuditedValue(argument, auditedSources, checker, resolving),
    );
  }
  if (ts.isConditionalExpression(current)) {
    return (
      rendersAuditedValue(current.whenTrue, auditedSources, checker, resolving) ||
      rendersAuditedValue(current.whenFalse, auditedSources, checker, resolving)
    );
  }
  if (ts.isBinaryExpression(current)) {
    if (current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return rendersAuditedValue(current.right, auditedSources, checker, resolving);
    }
    if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return rendersAuditedValue(current.right, auditedSources, checker, resolving);
    }
    if (
      current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      current.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      return (
        rendersAuditedValue(current.left, auditedSources, checker, resolving) ||
        rendersAuditedValue(current.right, auditedSources, checker, resolving)
      );
    }
  }
  return false;
}

/**
 * Bind every audited opaque-identifier display and address input to its real
 * executable AST node. Comments, strings, aliases, and decorative lookalikes
 * cannot satisfy this inventory.
 */
export function assertBidiIdentifierPolicy(sources: BidiProductionSources): void {
  for (const [fileName, expectedSites] of Object.entries(EXPECTED_SITES)) {
    const source = sources[fileName];
    if (source === undefined) throw new Error(`missing production source: ${fileName}`);
    const file = parse(fileName, source);
    const importBinding = exactImportBinding(file);
    if (!importBinding) {
      throw new Error(`${fileName} must import BidiIdentifier without an alias`);
    }
    const checker = checkerFor(fileName, file);
    const actualSites: string[] = [];
    const auditedSourcesByFunction = new Map<string, ts.Expression[]>();
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "truncateAddress"
      ) {
        throw new Error(`${fileName} bypasses BidiIdentifier with truncateAddress`);
      }
      if (
        ts.isJsxSelfClosingElement(node) &&
        isImportedBidiTag(node.tagName, importBinding, checker)
      ) {
        actualSites.push(actualSiteKey(file, node));
        const functionName = enclosingFunctionName(node) ?? "";
        const value = expressionAttributeNode(node.attributes, "value");
        if (value) {
          const current = auditedSourcesByFunction.get(functionName) ?? [];
          current.push(value);
          auditedSourcesByFunction.set(functionName, current);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    assertExactMultiset(
      fileName,
      actualSites,
      expectedSites.map(siteKey),
    );
    const rawDisplays: string[] = [];
    const visitDisplays = (node: ts.Node) => {
      if (ts.isJsxExpression(node)) {
        const expression = displayedJsxExpression(node, importBinding, checker);
        const functionName = enclosingFunctionName(node) ?? "";
        const auditedSources = auditedSourcesByFunction.get(functionName) ?? [];
        if (
          expression &&
          auditedSources.length > 0 &&
          rendersAuditedValue(expression, auditedSources, checker)
        ) {
          rawDisplays.push(`${functionName}|${expression.getText(file)}`);
        }
      }
      if (ts.isJsxSpreadAttribute(node)) {
        const functionName = enclosingFunctionName(node) ?? "";
        const auditedSources = auditedSourcesByFunction.get(functionName) ?? [];
        if (
          auditedSources.length > 0 &&
          rendersAuditedValue(node.expression, auditedSources, checker)
        ) {
          rawDisplays.push(`${functionName}|...${node.expression.getText(file)}`);
        }
      }
      ts.forEachChild(node, visitDisplays);
    };
    visitDisplays(file);
    if (rawDisplays.length > 0) {
      throw new Error(
        `${fileName} renders audited identifier values outside imported BidiIdentifier: ${rawDisplays.join(", ")}`,
      );
    }
  }

  for (const [fileName, expectedIds] of Object.entries(EXPECTED_LTR_INPUTS)) {
    const source = sources[fileName];
    if (source === undefined) throw new Error(`missing production source: ${fileName}`);
    const file = parse(fileName, source);
    const actualIds: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isJsxSelfClosingElement(node) &&
        ts.isIdentifier(node.tagName) &&
        node.tagName.text === "Input"
      ) {
        const id = stringAttribute(node.attributes, "id");
        if (id && expectedIds.includes(id)) {
          if (stringAttribute(node.attributes, "dir") !== "ltr") {
            throw new Error(`${fileName} input ${id} must use literal dir=ltr`);
          }
          actualIds.push(id);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    assertExactMultiset(fileName, actualIds, [...expectedIds]);
  }
}
