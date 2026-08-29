import ts from "typescript";

type ProductionSources = Readonly<Record<string, string>>;

function parseSource(fileName: string, source: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    fileName.replace(/^\.\//, ""),
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & {
      readonly parseDiagnostics: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    throw new Error(`i18n source policy cannot parse ${fileName}`);
  }
  return sourceFile;
}

function propertyName(node: ts.Node): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function catalogImportPath(node: ts.CallExpression): string | null {
  if (
    node.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    node.arguments.length !== 1 ||
    !ts.isStringLiteral(node.arguments[0])
  ) {
    return null;
  }
  return node.arguments[0].text;
}

function isCatalogPath(path: string): boolean {
  return /(?:^|\/)(?:i18n\/)?locales\/[^/]+\.json$/.test(path);
}

function staticCatalogPath(statement: ts.Statement): string | null {
  if (
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    isCatalogPath(statement.moduleSpecifier.text)
  ) {
    return statement.moduleSpecifier.text;
  }
  return null;
}

function dynamicCatalogImports(node: ts.Node): string[] {
  const imports: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child)) {
      const path = catalogImportPath(child);
      if (path && isCatalogPath(path)) {
        imports.push(path);
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return imports;
}

function returnedCatalogImport(
  loader: ts.ArrowFunction,
  expectedPath: string,
): boolean {
  if (ts.isBlock(loader.body) || !ts.isCallExpression(loader.body))
    return false;
  const thenAccess = loader.body.expression;
  if (
    !ts.isPropertyAccessExpression(thenAccess) ||
    thenAccess.name.text !== "then" ||
    !ts.isCallExpression(thenAccess.expression)
  ) {
    return false;
  }
  return catalogImportPath(thenAccess.expression) === expectedPath;
}

function frozenCatalogRegistry(
  initializer: ts.Expression | undefined,
): ts.ObjectLiteralExpression | null {
  if (
    !initializer ||
    !ts.isCallExpression(initializer) ||
    initializer.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(initializer.expression) ||
    !ts.isIdentifier(initializer.expression.expression) ||
    initializer.expression.expression.text !== "Object" ||
    initializer.expression.name.text !== "freeze" ||
    !ts.isObjectLiteralExpression(initializer.arguments[0])
  ) {
    return null;
  }
  return initializer.arguments[0];
}

/** Require one executable lazy catalog loader per locale and no eager imports. */
export function assertCatalogLoaders(
  source: string,
  supportedLocales: readonly string[],
  otherProductionSources: ProductionSources = {},
): void {
  const sourceFile = parseSource("src/i18n/index.ts", source);
  for (const statement of sourceFile.statements) {
    const path = staticCatalogPath(statement);
    if (path) {
      throw new Error(
        `catalog must not use a static import or re-export: ${path}`,
      );
    }
  }

  const declarations = sourceFile.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "CATALOG_LOADERS",
    );
  if (declarations.length !== 1) {
    throw new Error("source must declare exactly one CATALOG_LOADERS registry");
  }

  const initializer = frozenCatalogRegistry(declarations[0].initializer);
  if (!initializer) {
    throw new Error(
      "CATALOG_LOADERS must be one Object.freeze-wrapped object literal",
    );
  }
  const properties = new Map<string, ts.PropertyAssignment>();
  for (const member of initializer.properties) {
    if (!ts.isPropertyAssignment(member)) {
      throw new Error("CATALOG_LOADERS entries must be property assignments");
    }
    const name = propertyName(member.name);
    if (!name || properties.has(name)) {
      throw new Error(
        `invalid or duplicate catalog loader: ${name ?? "unknown"}`,
      );
    }
    properties.set(name, member);
  }

  const supported = new Set(supportedLocales);
  const extra = [...properties.keys()].filter(
    (locale) => !supported.has(locale),
  );
  if (extra.length > 0) {
    throw new Error(`unsupported catalog loader: ${extra.sort().join(", ")}`);
  }
  for (const locale of supportedLocales) {
    const member = properties.get(locale);
    if (!member) throw new Error(`missing catalog loader: ${locale}`);
    const expectedPath = `./locales/${locale}.json`;
    if (
      !ts.isArrowFunction(member.initializer) ||
      !returnedCatalogImport(member.initializer, expectedPath)
    ) {
      throw new Error(
        `catalog loader ${locale} must return the dynamic import ${expectedPath}`,
      );
    }
    const imports = dynamicCatalogImports(member.initializer);
    if (imports.length !== 1 || imports[0] !== expectedPath) {
      throw new Error(
        `catalog loader ${locale} must import only ${expectedPath}`,
      );
    }
  }

  const expectedImports = supportedLocales
    .map((locale) => `./locales/${locale}.json`)
    .sort();
  const allImports = dynamicCatalogImports(sourceFile).sort();
  if (
    allImports.length !== expectedImports.length ||
    allImports.some((path, index) => path !== expectedImports[index])
  ) {
    throw new Error(
      "catalog imports must exist only inside their lazy loaders",
    );
  }

  for (const [fileName, otherSource] of Object.entries(
    otherProductionSources,
  )) {
    const otherFile = parseSource(fileName, otherSource);
    const hasStaticCatalogImport = otherFile.statements.some((statement) =>
      Boolean(staticCatalogPath(statement)),
    );
    if (hasStaticCatalogImport || dynamicCatalogImports(otherFile).length > 0) {
      throw new Error(`catalog import outside loader registry: ${fileName}`);
    }
  }
}

function checkerFor(
  fileName: string,
  sourceFile: ts.SourceFile,
): ts.TypeChecker {
  const options: ts.CompilerOptions = {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
    types: [],
  };
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const compilerFileName = sourceFile.fileName;
  host.getSourceFile = (
    candidate,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    candidate === compilerFileName
      ? sourceFile
      : getSourceFile(
          candidate,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );
  return ts.createProgram([fileName], options, host).getTypeChecker();
}

function messageKeysImportBinding(file: ts.SourceFile): ts.Identifier | null {
  const bindings = file.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !["@/i18n/messages", "./messages"].includes(
        statement.moduleSpecifier.text,
      ) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      return [];
    }
    return statement.importClause.namedBindings.elements
      .filter(
        (element) =>
          element.propertyName === undefined &&
          element.name.text === "MESSAGE_KEYS",
      )
      .map((element) => element.name);
  });
  return bindings.length === 1 ? bindings[0] : null;
}

function propertyAccessName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return null;
}

function isImportedMessageKeyAccess(
  node: ts.Node,
  importBinding: ts.Identifier,
  checker: ts.TypeChecker,
): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return false;
  }
  return (
    ts.isIdentifier(node.expression) &&
    checker.getSymbolAtLocation(node.expression) ===
      checker.getSymbolAtLocation(importBinding) &&
    propertyAccessName(node) !== null
  );
}

function containsNode(ancestor: ts.Node, descendant: ts.Node): boolean {
  return ancestor.pos <= descendant.pos && descendant.end <= ancestor.end;
}

function translatedAttributeCanBeOverridden(output: ts.JsxExpression): boolean {
  const attribute = output.parent;
  if (
    !ts.isJsxAttribute(attribute) ||
    attribute.initializer !== output ||
    !ts.isIdentifier(attribute.name) ||
    !ts.isJsxAttributes(attribute.parent)
  ) {
    return false;
  }
  const attributeName = attribute.name.text;
  const attributes = attribute.parent.properties;
  const index = attributes.indexOf(attribute);
  return attributes
    .slice(index + 1)
    .some(
      (candidate) =>
        ts.isJsxSpreadAttribute(candidate) ||
        (ts.isJsxAttribute(candidate) &&
          ts.isIdentifier(candidate.name) &&
          candidate.name.text === attributeName),
    );
}

type ImportedSinkContract = Readonly<Record<string, readonly string[]>>;

/**
 * A deliberately small boundary, not a claim that arbitrary React components
 * render arbitrary props. Each entry is an audited import plus the exact prop
 * that reaches user-visible output. Component tests remain responsible for the
 * component's runtime output.
 */
const REVIEWED_IMPORTED_SINKS: Readonly<Record<string, ImportedSinkContract>> =
  {
    "@/components/common/EmptyState": {
      EmptyState: ["action", "description", "title"],
    },
    "@/components/ui/button": { Button: ["children"] },
    "@/components/ui/dialog": {
      Dialog: ["children"],
      DialogContent: ["children"],
      DialogDescription: ["children"],
      DialogTitle: ["children"],
      DialogTrigger: ["children"],
    },
    "@/components/ui/dropdown-menu": {
      DropdownMenu: ["children"],
      DropdownMenuContent: ["children"],
      DropdownMenuItem: ["children"],
      DropdownMenuLabel: ["children"],
      DropdownMenuTrigger: ["children"],
    },
    "@/components/ui/tooltip": {
      Tooltip: ["children"],
      TooltipContent: ["children"],
      TooltipTrigger: ["children"],
    },
    "react-router-dom": { Link: ["aria-label", "children"] },
  };

function jsxTagForAttributes(
  attributes: ts.JsxAttributes,
): ts.JsxTagNameExpression | null {
  const element = attributes.parent;
  return ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)
    ? element.tagName
    : null;
}

function isIntrinsicTag(tagName: ts.JsxTagNameExpression): boolean {
  return ts.isIdentifier(tagName) && /^[a-z]/.test(tagName.text);
}

function importedTagIdentity(
  tagName: ts.JsxTagNameExpression,
  checker: ts.TypeChecker,
): { importedName: string; moduleName: string } | null {
  if (!ts.isIdentifier(tagName)) return null;
  const symbol = checker.getSymbolAtLocation(tagName);
  const declarations = symbol?.declarations ?? [];
  if (declarations.length !== 1) return null;
  const declaration = declarations[0];
  if (!ts.isImportSpecifier(declaration)) return null;
  const importDeclaration = ts.findAncestor(
    declaration,
    ts.isImportDeclaration,
  );
  if (
    !importDeclaration ||
    !ts.isStringLiteral(importDeclaration.moduleSpecifier)
  ) {
    return null;
  }
  return {
    importedName: declaration.propertyName?.text ?? declaration.name.text,
    moduleName: importDeclaration.moduleSpecifier.text,
  };
}

function importedIdentifierIdentity(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
): { importedName: string; moduleName: string } | null {
  const declarations =
    checker.getSymbolAtLocation(identifier)?.declarations ?? [];
  if (declarations.length !== 1 || !ts.isImportSpecifier(declarations[0])) {
    return null;
  }
  const declaration = declarations[0];
  const importDeclaration = declaration.parent.parent.parent;
  if (
    !ts.isImportDeclaration(importDeclaration) ||
    !ts.isStringLiteral(importDeclaration.moduleSpecifier)
  ) {
    return null;
  }
  return {
    importedName: declaration.propertyName?.text ?? declaration.name.text,
    moduleName: importDeclaration.moduleSpecifier.text,
  };
}

function namespaceImportModule(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
): string | null {
  const declarations =
    checker.getSymbolAtLocation(identifier)?.declarations ?? [];
  if (declarations.length !== 1 || !ts.isNamespaceImport(declarations[0])) {
    return null;
  }
  const importDeclaration = ts.findAncestor(
    declarations[0],
    ts.isImportDeclaration,
  );
  return importDeclaration &&
    ts.isStringLiteral(importDeclaration.moduleSpecifier)
    ? importDeclaration.moduleSpecifier.text
    : null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return [
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.LessThanLessThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken,
    ts.SyntaxKind.BarEqualsToken,
    ts.SyntaxKind.CaretEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ].includes(kind);
}

function identifierIsWritten(identifier: ts.Identifier): boolean {
  for (
    let current: ts.Node = identifier;
    current.parent;
    current = current.parent
  ) {
    const parent = current.parent;
    if (
      ts.isBinaryExpression(parent) &&
      isAssignmentOperator(parent.operatorToken.kind) &&
      containsNode(parent.left, identifier)
    ) {
      return true;
    }
    if (
      ((ts.isPrefixUnaryExpression(parent) &&
        [
          ts.SyntaxKind.PlusPlusToken,
          ts.SyntaxKind.MinusMinusToken,
        ].includes(parent.operator)) ||
        ts.isPostfixUnaryExpression(parent)) &&
      containsNode(parent.operand, identifier)
    ) {
      return true;
    }
    if (
      (ts.isDeleteExpression(parent) &&
        containsNode(parent.expression, identifier)) ||
      ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) &&
        containsNode(parent.initializer, identifier))
    ) {
      return true;
    }
    if (ts.isStatement(parent)) break;
  }
  return false;
}

function identifierIsDeclarationName(
  identifier: ts.Identifier,
  symbol: ts.Symbol,
): boolean {
  return (symbol.declarations ?? []).some((declaration) => {
    if (
      (ts.isVariableDeclaration(declaration) ||
        ts.isBindingElement(declaration) ||
        ts.isParameter(declaration)) &&
      containsNode(declaration.name, identifier)
    ) {
      return true;
    }
    return false;
  });
}

function symbolHasWrite(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  const sourceFile = symbol.declarations?.[0]?.getSourceFile();
  if (!sourceFile) return true;
  let written = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      checker.getSymbolAtLocation(node) === symbol &&
      !identifierIsDeclarationName(node, symbol) &&
      identifierIsWritten(node)
    ) {
      written = true;
      return;
    }
    if (!written) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return written;
}

function stableVariableSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  return !symbolHasWrite(symbol, checker);
}

function unwrappedParent(identifier: ts.Identifier): {
  current: ts.Node;
  parent: ts.Node;
} | null {
  let current: ts.Node = identifier;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent;
  }
  const parent = current.parent;
  return parent ? { current, parent } : null;
}

function hookResultUseIsStable(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  const relationship = unwrappedParent(identifier);
  if (!relationship) return false;
  const { current, parent } = relationship;
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === current
  ) {
    return propertyAccessName(parent) === "t";
  }
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== current) {
    return false;
  }
  if (ts.isIdentifier(parent.name)) {
    const alias = checker.getSymbolAtLocation(parent.name);
    return Boolean(
      alias && hookResultSymbolIsStable(alias, parent, checker, seen),
    );
  }
  if (!ts.isObjectBindingPattern(parent.name)) return false;
  return parent.name.elements.every((element) => {
    if (element.dotDotDotToken) return false;
    const property = element.propertyName ?? element.name;
    if (propertyName(property) !== "t" || !ts.isIdentifier(element.name)) {
      return false;
    }
    const translator = checker.getSymbolAtLocation(element.name);
    return Boolean(translator && stableVariableSymbol(translator, checker));
  });
}

function hookResultSymbolIsStable(
  symbol: ts.Symbol,
  declaration: ts.VariableDeclaration,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (seen.has(symbol)) return false;
  seen.add(symbol);
  if (!stableVariableSymbol(symbol, checker)) return false;
  let safe = true;
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      checker.getSymbolAtLocation(node) === symbol &&
      !identifierIsDeclarationName(node, symbol) &&
      !hookResultUseIsStable(node, checker, new Set(seen))
    ) {
      safe = false;
      return;
    }
    if (safe) ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  return safe;
}

function isImportedFunction(
  expression: ts.Expression,
  moduleName: string,
  importedName: string,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    const identity = importedIdentifierIdentity(current, checker);
    if (
      identity?.moduleName === moduleName &&
      identity.importedName === importedName
    ) {
      return true;
    }
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    return (symbol.declarations ?? []).some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        stableVariableSymbol(symbol, checker) &&
        Boolean(
          declaration.initializer &&
          isImportedFunction(
            declaration.initializer,
            moduleName,
            importedName,
            checker,
            seen,
          ),
        ),
    );
  }
  return (
    ts.isPropertyAccessExpression(current) &&
    current.name.text === importedName &&
    ts.isIdentifier(current.expression) &&
    namespaceImportModule(current.expression, checker) === moduleName
  );
}

function isHookResult(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  const current = unwrapExpression(expression);
  if (ts.isCallExpression(current)) {
    return isImportedFunction(
      current.expression,
      "react-i18next",
      "useTranslation",
      checker,
      new Set(seen),
    );
  }
  if (!ts.isIdentifier(current)) return false;
  const symbol = checker.getSymbolAtLocation(current);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  return (symbol.declarations ?? []).some(
    (declaration) =>
      ts.isVariableDeclaration(declaration) &&
      hookResultSymbolIsStable(symbol, declaration, checker) &&
      Boolean(
        declaration.initializer &&
        isHookResult(declaration.initializer, checker, seen),
      ),
  );
}

function accessIsHookTranslator(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  return (
    propertyAccessName(expression) === "t" &&
    isHookResult(expression.expression, checker, seen)
  );
}

function isHookTranslator(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  const current = unwrapExpression(expression);
  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    return accessIsHookTranslator(current, checker, seen);
  }
  if (!ts.isIdentifier(current)) return false;
  const symbol = checker.getSymbolAtLocation(current);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  return (symbol.declarations ?? []).some((declaration) => {
    if (ts.isBindingElement(declaration)) {
      const property = declaration.propertyName ?? declaration.name;
      const variable = declaration.parent.parent;
      return (
        propertyName(property) === "t" &&
        ts.isVariableDeclaration(variable) &&
        stableVariableSymbol(symbol, checker) &&
        Boolean(
          variable.initializer &&
          isHookResult(variable.initializer, checker, seen),
        )
      );
    }
    return (
      ts.isVariableDeclaration(declaration) &&
      stableVariableSymbol(symbol, checker) &&
      Boolean(
        declaration.initializer &&
        isHookTranslator(declaration.initializer, checker, seen),
      )
    );
  });
}

type FunctionWithBody =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

function isFunctionWithBody(node: ts.Node): node is FunctionWithBody {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function returnedExpressions(functionNode: FunctionWithBody): ts.Expression[] {
  if (!functionNode.body || !ts.isBlock(functionNode.body)) return [];
  const returns: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (node !== functionNode && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) returns.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(functionNode.body, visit);
  return returns;
}

function isI18nextInstance(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  const current = unwrapExpression(expression);
  if (ts.isCallExpression(current)) {
    if (
      isImportedFunction(
        current.expression,
        "i18next",
        "createInstance",
        checker,
        new Set(seen),
      )
    ) {
      return true;
    }
    if (!ts.isIdentifier(current.expression)) return false;
    const functionSymbol = checker.getSymbolAtLocation(current.expression);
    if (!functionSymbol || seen.has(functionSymbol)) return false;
    seen.add(functionSymbol);
    return (functionSymbol.declarations ?? []).some((declaration) => {
      if (!isFunctionWithBody(declaration)) return false;
      const returns = returnedExpressions(declaration);
      return (
        returns.length > 0 &&
        returns.every((returned) =>
          isI18nextInstance(returned, checker, new Set(seen)),
        )
      );
    });
  }
  if (!ts.isIdentifier(current)) return false;
  const symbol = checker.getSymbolAtLocation(current);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  return (symbol.declarations ?? []).some(
    (declaration) =>
      ts.isVariableDeclaration(declaration) &&
      Boolean(
        declaration.initializer &&
        isI18nextInstance(declaration.initializer, checker, seen),
      ),
  );
}

function isTranslationCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  if (isHookTranslator(call.expression, checker, new Set())) return true;
  const expression = unwrapExpression(call.expression);
  return (
    (ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression)) &&
    propertyAccessName(expression) === "t" &&
    isI18nextInstance(expression.expression, checker, new Set())
  );
}

function staticBoolean(node: ts.Expression): boolean | null {
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text.length > 0;
  if (ts.isNumericLiteral(node)) return Number(node.text) !== 0;
  if (ts.isParenthesizedExpression(node)) return staticBoolean(node.expression);
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const operand = staticBoolean(node.operand);
    return operand === null ? null : !operand;
  }
  return null;
}

function staticNullish(node: ts.Expression): boolean | null {
  if (node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  ) {
    return false;
  }
  if (ts.isParenthesizedExpression(node)) return staticNullish(node.expression);
  return null;
}

function isStaticallyDead(node: ts.Node, boundary: ts.Node): boolean {
  for (
    let current = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (ts.isBinaryExpression(current) && containsNode(current.right, node)) {
      const left = staticBoolean(current.left);
      if (
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          left === false) ||
        (current.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
          left === true)
      ) {
        return true;
      }
      if (
        current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        staticNullish(current.left) === false
      ) {
        return true;
      }
    }
    if (ts.isConditionalExpression(current)) {
      const condition = staticBoolean(current.condition);
      if (
        (condition === true && containsNode(current.whenFalse, node)) ||
        (condition === false && containsNode(current.whenTrue, node))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether `child` contributes its value to the value of its immediate parent.
 * This is intentionally an allowlist. A catalog lookup used only as a
 * condition, discarded comma operand, function argument, or property receiver
 * is execution but not translated output.
 */
function valueContributesToParent(child: ts.Node, parent: ts.Node): boolean {
  if (
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isAwaitExpression(parent)) &&
    parent.expression === child
  ) {
    return true;
  }
  if (ts.isJsxExpression(parent)) return parent.expression === child;
  if (ts.isTemplateSpan(parent)) return parent.expression === child;
  if (ts.isTemplateExpression(parent)) {
    return parent.templateSpans.some((span) => span === child);
  }
  if (ts.isArrayLiteralExpression(parent)) {
    return parent.elements.some((element) => element === child);
  }
  if (ts.isConditionalExpression(parent)) {
    return parent.whenTrue === child || parent.whenFalse === child;
  }
  if (!ts.isBinaryExpression(parent)) return false;

  switch (parent.operatorToken.kind) {
    case ts.SyntaxKind.CommaToken:
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return parent.right === child;
    case ts.SyntaxKind.BarBarToken:
    case ts.SyntaxKind.QuestionQuestionToken:
    case ts.SyntaxKind.PlusToken:
      return parent.left === child || parent.right === child;
    default:
      return false;
  }
}

function localFunctionForTag(
  tagName: ts.JsxTagNameExpression,
  checker: ts.TypeChecker,
): ts.FunctionLikeDeclaration | null {
  if (!ts.isIdentifier(tagName)) return null;
  const declarations = checker.getSymbolAtLocation(tagName)?.declarations ?? [];
  if (declarations.length !== 1) return null;
  const declaration = declarations[0];
  if (ts.isFunctionDeclaration(declaration)) return declaration;
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  ) {
    return declaration.initializer;
  }
  return null;
}

function localPropBinding(
  component: ts.FunctionLikeDeclaration,
  propName: string,
): ts.Identifier | null {
  const parameter = component.parameters[0];
  if (!parameter || !ts.isObjectBindingPattern(parameter.name)) return null;
  for (const element of parameter.name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const boundProp = element.propertyName
      ? propertyName(element.propertyName)
      : element.name.text;
    if (boundProp === propName) return element.name;
  }
  return null;
}

function identifierReachesIntrinsicSink(
  identifier: ts.Identifier,
  component: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): boolean {
  if (!component.body) return false;
  const binding = checker.getSymbolAtLocation(identifier);
  let rendered = false;
  const visit = (node: ts.Node) => {
    if (
      rendered ||
      !ts.isIdentifier(node) ||
      node === identifier ||
      checker.getSymbolAtLocation(node) !== binding ||
      isStaticallyDead(node, component)
    ) {
      ts.forEachChild(node, visit);
      return;
    }
    let value: ts.Node = node;
    for (
      let parent = value.parent;
      parent && parent !== component;
      parent = value.parent
    ) {
      if (ts.isJsxExpression(parent)) {
        if (!valueContributesToParent(value, parent)) break;
        if (ts.isJsxAttribute(parent.parent)) {
          const tagName = jsxTagForAttributes(parent.parent.parent);
          rendered = Boolean(
            tagName &&
            isIntrinsicTag(tagName) &&
            !translatedAttributeCanBeOverridden(parent),
          );
        } else if (ts.isJsxElement(parent.parent)) {
          rendered = isIntrinsicTag(parent.parent.openingElement.tagName);
        }
        break;
      }
      if (!valueContributesToParent(value, parent)) break;
      value = parent;
    }
  };
  ts.forEachChild(component.body, visit);
  return rendered;
}

function localComponentRendersProp(
  tagName: ts.JsxTagNameExpression,
  propName: string,
  checker: ts.TypeChecker,
): boolean {
  const component = localFunctionForTag(tagName, checker);
  if (!component) return false;
  const binding = localPropBinding(component, propName);
  return Boolean(
    binding && identifierReachesIntrinsicSink(binding, component, checker),
  );
}

function componentAcceptsSink(
  tagName: ts.JsxTagNameExpression,
  propName: string,
  checker: ts.TypeChecker,
): boolean {
  if (isIntrinsicTag(tagName)) return true;
  const imported = importedTagIdentity(tagName, checker);
  if (imported) {
    return Boolean(
      REVIEWED_IMPORTED_SINKS[imported.moduleName]?.[
        imported.importedName
      ]?.includes(propName),
    );
  }
  return localComponentRendersProp(tagName, propName, checker);
}

function jsxExpressionReachesReviewedSink(
  output: ts.JsxExpression,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isJsxAttribute(output.parent)) {
    if (translatedAttributeCanBeOverridden(output)) return false;
    const attribute = output.parent;
    if (!ts.isIdentifier(attribute.name)) return false;
    const tagName = jsxTagForAttributes(attribute.parent);
    return Boolean(
      tagName && componentAcceptsSink(tagName, attribute.name.text, checker),
    );
  }
  if (ts.isJsxElement(output.parent)) {
    return componentAcceptsSink(
      output.parent.openingElement.tagName,
      "children",
      checker,
    );
  }
  return ts.isJsxFragment(output.parent);
}

function jsxElementReachesReviewedParent(
  element: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
  checker: ts.TypeChecker,
): boolean {
  const parent = element.parent;
  if (ts.isJsxElement(parent)) {
    return componentAcceptsSink(
      parent.openingElement.tagName,
      "children",
      checker,
    );
  }
  return true;
}

function jsxValueContaining(
  output: ts.JsxExpression,
): ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | null {
  if (ts.isJsxElement(output.parent) || ts.isJsxFragment(output.parent)) {
    return output.parent;
  }
  if (!ts.isJsxAttribute(output.parent)) return null;
  const owner = output.parent.parent.parent;
  if (ts.isJsxSelfClosingElement(owner)) return owner;
  if (ts.isJsxOpeningElement(owner) && ts.isJsxElement(owner.parent)) {
    return owner.parent;
  }
  return null;
}

function translationReachesReviewedJsx(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  let sawJsx = false;
  let value: ts.Node = call;
  for (
    let parent = value.parent;
    parent && !ts.isStatement(parent);
    parent = value.parent
  ) {
    if (ts.isJsxExpression(parent)) {
      if (!valueContributesToParent(value, parent)) return false;
      sawJsx = true;
      if (!jsxExpressionReachesReviewedSink(parent, checker)) return false;
      const containingValue = jsxValueContaining(parent);
      if (!containingValue) return false;
      value = containingValue;
      continue;
    }
    if (
      (ts.isJsxElement(value) ||
        ts.isJsxSelfClosingElement(value) ||
        ts.isJsxFragment(value)) &&
      (ts.isJsxElement(parent) || ts.isJsxFragment(parent))
    ) {
      if (!jsxElementReachesReviewedParent(value, checker)) return false;
      value = parent;
      continue;
    }
    if (!valueContributesToParent(value, parent)) return false;
    value = parent;
  }
  return sawJsx;
}

function isRenderedTranslationCall(
  access: ts.Node,
  fileName: string,
  checker: ts.TypeChecker,
): boolean {
  for (let current = access.parent; current; current = current.parent) {
    if (ts.isVoidExpression(current)) {
      return false;
    }
    if (
      ts.isCallExpression(current) &&
      current.arguments.some((argument) => containsNode(argument, access))
    ) {
      if (!isTranslationCall(current, checker)) continue;
      const statement = ts.findAncestor(current, ts.isStatement);
      if (statement && isStaticallyDead(current, statement)) return false;
      for (
        let output = current.parent;
        output && !ts.isStatement(output);
        output = output.parent
      ) {
        if (ts.isJsxExpression(output))
          return translationReachesReviewedJsx(current, checker);
        if (
          ts.isCallExpression(output) &&
          output.arguments.some((argument) =>
            containsNode(argument, current),
          ) &&
          ts.isIdentifier(output.expression) &&
          output.expression.text === "configureFormattingLocale"
        ) {
          return true;
        }
      }
      return false;
    }
  }

  if (!fileName.endsWith("/components/layout/navigation.ts")) return false;
  for (let current = access.parent; current; current = current.parent) {
    if (ts.isPropertyAssignment(current)) {
      const name = propertyName(current.name);
      if (name === "labelKey" || name === "accessibleLabelKey") return true;
    }
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.name.text === "NAVIGATION_GROUP_LABEL_KEYS"
    ) {
      return true;
    }
  }
  return false;
}

/** Require imported MESSAGE_KEYS reads that feed reviewed translated output. */
export function assertMessageKeyConsumers(
  productionSources: ProductionSources,
  declaredProperties: readonly string[],
): void {
  const consumed = new Set<string>();
  for (const [fileName, source] of Object.entries(productionSources)) {
    const sourceFile = parseSource(fileName, source);
    const importBinding = messageKeysImportBinding(sourceFile);
    if (!importBinding) continue;
    const checker = checkerFor(fileName, sourceFile);
    const visit = (node: ts.Node) => {
      if (isImportedMessageKeyAccess(node, importBinding, checker)) {
        const name = propertyAccessName(node);
        if (name && isRenderedTranslationCall(node, fileName, checker))
          consumed.add(name);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const missing = declaredProperties.filter(
    (property) => !consumed.has(property),
  );
  if (missing.length > 0) {
    throw new Error(
      `message keys lack executable consumers: ${missing.join(", ")}`,
    );
  }
}
