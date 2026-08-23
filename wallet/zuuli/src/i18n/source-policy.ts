import ts from "typescript";

type ProductionSources = Readonly<Record<string, string>>;

function parseSource(fileName: string, source: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    fileName,
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

function propertyName(node: ts.PropertyName): string | null {
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

function dynamicCatalogImports(node: ts.Node): string[] {
  const imports: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child)) {
      const path = catalogImportPath(child);
      if (path?.startsWith("./locales/") && path.endsWith(".json")) {
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
  if (ts.isBlock(loader.body) || !ts.isCallExpression(loader.body)) return false;
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

/** Require one executable lazy catalog loader per locale and no eager imports. */
export function assertCatalogLoaders(
  source: string,
  supportedLocales: readonly string[],
): void {
  const sourceFile = parseSource("src/i18n/index.ts", source);
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith("./locales/") &&
      statement.moduleSpecifier.text.endsWith(".json")
    ) {
      throw new Error(
        `catalog must not use a static import: ${statement.moduleSpecifier.text}`,
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

  const initializer = declarations[0].initializer;
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
    throw new Error("CATALOG_LOADERS must be an object literal");
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
  const extra = [...properties.keys()].filter((locale) => !supported.has(locale));
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
    throw new Error("catalog imports must exist only inside their lazy loaders");
  }
}

/** Require executable MESSAGE_KEYS property reads; comments and strings do not count. */
export function assertMessageKeyConsumers(
  productionSources: ProductionSources,
  declaredProperties: readonly string[],
): void {
  const consumed = new Set<string>();
  for (const [fileName, source] of Object.entries(productionSources)) {
    const sourceFile = parseSource(fileName, source);
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "MESSAGE_KEYS"
      ) {
        consumed.add(node.name.text);
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "MESSAGE_KEYS" &&
        node.argumentExpression &&
        ts.isStringLiteral(node.argumentExpression)
      ) {
        consumed.add(node.argumentExpression.text);
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
