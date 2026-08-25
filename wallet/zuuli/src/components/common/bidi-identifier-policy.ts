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
    { functionName: "Send", value: "result.txid", shorten: true },
    { functionName: "Send", value: "result.txid", shorten: true },
    { functionName: "Send", value: "pendingSend.txid", shorten: false },
    {
      functionName: "Send",
      value: 'proposal.review.payments[0]?.recipient ?? ""',
      shorten: false,
    },
    { functionName: "Send", value: "broadcastResult.txid", shorten: false },
  ],
  "src/features/auth/ZcashLoginFlow.tsx": [
    { functionName: "ZcashLoginFlow", value: "address", shorten: true },
  ],
  "src/features/profile/LinkedAccounts.tsx": [
    { functionName: "ZcashLinkDialogBody", value: "address", shorten: true },
    { functionName: "ZcashLinkDialogBody", value: "address", shorten: true },
    {
      functionName: "LinkedAccounts",
      value: "did",
      shorten: true,
      head: "16",
      tail: "6",
    },
  ],
  "src/features/live/Room.tsx": [
    {
      functionName: "ConnectedDetails",
      value: "ticket.meetingId",
      shorten: true,
    },
    {
      functionName: "ConnectedDetails",
      value: "ticket.roomName",
      shorten: true,
    },
  ],
};

const EXPECTED_LTR_INPUTS: Readonly<Record<string, readonly string[]>> = {
  "src/features/wallet/Send.tsx": ["to"],
  "src/features/profile/index.tsx": ["profile-p2paddr"],
};

function parse(fileName: string, source: string): ts.SourceFile {
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
  return program.getTypeChecker();
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

function directDisplayExpression(file: ts.SourceFile, node: ts.JsxExpression): string | null {
  if (
    !node.expression ||
    (!ts.isJsxElement(node.parent) && !ts.isJsxFragment(node.parent))
  ) {
    return null;
  }
  let expression = node.expression;
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression.getText(file);
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
    const expectedValuesByFunction = new Map<string, Set<string>>();
    for (const site of expectedSites) {
      const values = expectedValuesByFunction.get(site.functionName) ?? new Set<string>();
      values.add(site.value);
      expectedValuesByFunction.set(site.functionName, values);
    }

    const actualSites: string[] = [];
    const rawDisplays: string[] = [];
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
      }
      if (ts.isJsxExpression(node)) {
        const value = directDisplayExpression(file, node);
        const functionName = enclosingFunctionName(node) ?? "";
        if (value && expectedValuesByFunction.get(functionName)?.has(value)) {
          rawDisplays.push(`${functionName}|${value}`);
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
