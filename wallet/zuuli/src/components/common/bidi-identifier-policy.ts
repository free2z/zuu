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

function directDisplayExpression(node: ts.JsxExpression): ts.Expression | null {
  if (
    !node.expression ||
    (!ts.isJsxElement(node.parent) && !ts.isJsxFragment(node.parent))
  ) {
    return null;
  }
  return node.expression;
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

function sameReference(
  left: ts.Expression,
  right: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const actual = unwrapExpression(left);
  const expected = unwrapExpression(right);
  if (ts.isIdentifier(actual) && ts.isIdentifier(expected)) {
    const actualSymbol = checker.getSymbolAtLocation(actual);
    return actualSymbol !== undefined && actualSymbol === checker.getSymbolAtLocation(expected);
  }
  if (
    ts.isPropertyAccessExpression(actual) &&
    ts.isPropertyAccessExpression(expected)
  ) {
    return (
      actual.name.text === expected.name.text &&
      sameReference(actual.expression, expected.expression, checker)
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
      sameReference(actual.expression, expected.expression, checker)
    );
  }
  return false;
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

const STRING_PRODUCING_METHODS = new Set([
  "at",
  "charAt",
  "concat",
  "normalize",
  "padEnd",
  "padStart",
  "repeat",
  "replace",
  "replaceAll",
  "slice",
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

function rendersAuditedValue(
  expression: ts.Expression,
  auditedSources: readonly ts.Expression[],
  checker: ts.TypeChecker,
  resolving = new Set<ts.Symbol>(),
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
    const declaration = symbol.declarations?.find(
      (candidate): candidate is ts.VariableDeclaration =>
        ts.isVariableDeclaration(candidate) && candidate.initializer !== undefined,
    );
    if (!declaration?.initializer) return false;
    const nextResolving = new Set(resolving);
    nextResolving.add(symbol);
    return rendersAuditedValue(
      declaration.initializer,
      auditedSources,
      checker,
      nextResolving,
    );
  }
  if (ts.isTemplateExpression(current)) {
    return current.templateSpans.some((span) =>
      rendersAuditedValue(span.expression, auditedSources, checker, resolving),
    );
  }
  if (ts.isCallExpression(current)) {
    if (
      ts.isPropertyAccessExpression(current.expression) &&
      STRING_PRODUCING_METHODS.has(current.expression.name.text) &&
      rendersAuditedValue(
        current.expression.expression,
        auditedSources,
        checker,
        resolving,
      )
    ) {
      return true;
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
        const expression = directDisplayExpression(node);
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
