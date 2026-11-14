import ts from "typescript";

type Sources = Readonly<Record<string, string>>;
const TEXT_ATTRIBUTES = new Set([
  "title",
  "description",
  "subtitle",
  "label",
  "aria-label",
  "placeholder",
  "alt",
  "ariaLabel",
  "linkLabel",
  "action",
  "closeLabel",
]);
// Names, protocol units and the marks used by provider-icon fallbacks. These
// exact values are data/identifiers, not a blanket exemption for a component.
const IDENTIFIERS = new Set([
  "ZUULI",
  "ZEC",
  "2Z",
  "Zcash",
  "Free2Z",
  "free2z",
  "Google",
  "GitHub",
  "Android",
  "iOS",
  "Linux",
  "macOS",
  "Windows",
  "Web",
  "X",
  "G",
  "gh",
  "txid",
  "0",
  "0.00",
  "you@example.com",
]);
const BOOTSTRAP_COPY = new Set([
  "Something went wrong",
  "ZUULI hit an unexpected error. Reloading usually fixes it.",
  "Reload",
]);
function parse(file: string, source: string) {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (
    (parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
      .parseDiagnostics.length
  )
    throw new Error(`i18n extraction policy cannot parse ${file}`);
  return parsed;
}
function normalize(path: string): string {
  const result: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") result.pop();
    else if (part !== "." && part) result.push(part);
  }
  return result.join("/");
}

/** Follow executable imports, including lazy route imports, from the real entry.
 * No hand-maintained feature list can silently lose a newly mounted route. */
export function productionClosure(
  sources: Sources,
  entry = "src/main.tsx",
): string[] {
  const found = new Set<string>();
  const visit = (file: string) => {
    if (found.has(file)) return;
    if (!(file in sources))
      throw new Error(`missing production source: ${file}`);
    found.add(file);
    const ast = parse(file, sources[file]);
    const walk = (node: ts.Node) => {
      let specifier: ts.Node | undefined;
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        const allTypes =
          named &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((item) => item.isTypeOnly);
        if (clause?.isTypeOnly || (!clause?.name && allTypes)) return;
        specifier = node.moduleSpecifier;
      }
      if (ts.isExportDeclaration(node)) {
        const named = node.exportClause;
        if (
          node.isTypeOnly ||
          (named &&
            ts.isNamedExports(named) &&
            named.elements.length > 0 &&
            named.elements.every((item) => item.isTypeOnly))
        )
          return;
        specifier = node.moduleSpecifier;
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
        specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier)) {
        const name = specifier.text.split("?")[0];
        const local = name.startsWith("@/")
          ? `src/${name.slice(2)}`
          : name.startsWith(".")
            ? normalize(`${file.slice(0, file.lastIndexOf("/"))}/${name}`)
            : null;
        if (local && !/\.(json|css|svg|png|wasm)$/.test(local)) {
          const resolved = [
            local,
            `${local}.ts`,
            `${local}.tsx`,
            `${local}/index.ts`,
            `${local}/index.tsx`,
          ].find((candidate) => candidate in sources);
          if (!resolved)
            throw new Error(`unresolved production import: ${file}: ${name}`);
          visit(resolved);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(ast);
  };
  visit(entry);
  return [...found].sort();
}
function hasWords(value: string): boolean {
  return (
    /[A-Za-z]/.test(value) &&
    !IDENTIFIERS.has(value) &&
    !/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(value)
  );
}
const TECHNICAL_VALUES: Readonly<Record<string, readonly string[]>> = {
  "src/components/ui/sonner.tsx": ["group-[.toast]:text-muted-foreground"],
  "src/features/wallet/funding/lib.ts": ["bg-secondary text-muted-foreground"],
  "src/features/wallet/funding/send-recipient.ts": [
    "zuuli.tuzi.pending-donation.v1",
  ],
  "src/features/wallet/shared.tsx": [
    "text-4xl min-[360px]:text-5xl md:text-6xl",
    "text-xl min-[360px]:text-2xl md:text-3xl",
    "ms-2 text-sm md:text-base",
  ],
};
function sentence(value: string): boolean {
  return (
    hasWords(value) &&
    (/^[A-Z][a-z]+$/.test(value) || /[A-Za-z][ ,.!?…—][ A-Za-z]/.test(value))
  );
}
// Only these catalog select parameters carry the protocol flags yes/no.
// Ordinary helper arguments and prose merely named yes/no are not exempt.
const SELECT_FLAGS: Readonly<Record<string, readonly string[]>> = {
  validAddress: ["memo"],
  fundingReceipt: ["replayed"],
  fundingConfirmed: ["replayed"],
};
const SELECTOR_LITERALS = new WeakSet<ts.Node>();
function isTechnical(
  node: ts.Node,
  file: ts.SourceFile,
  output: ReadonlySet<ts.Node>,
): boolean {
  if (
    !output.has(node) &&
    file.fileName === "src/app-bootstrap.tsx" &&
    ts.isStringLiteral(node) &&
    node.text === "ZUULI locale bootstrap failed" &&
    ts.isCallExpression(node.parent) &&
    node.parent.expression.getText(file) === "reportError" &&
    node.parent.arguments[0] === node
  )
    return true;
  return Boolean(
    ts.findAncestor(node, (ancestor) => {
      if (ts.isTypeNode(ancestor)) return true;
      if (ts.isImportDeclaration(ancestor) || ts.isExportDeclaration(ancestor))
        return true;
      if (ts.isNewExpression(ancestor) && !output.has(node)) return true;
      if (ts.isJsxAttribute(ancestor))
        return !TEXT_ATTRIBUTES.has(ancestor.name.getText(file));
      if (
        ts.isPropertyAssignment(ancestor) &&
        ancestor.name.getText(file) === "style"
      )
        return true;
      if (
        ts.isJsxExpression(ancestor) &&
        ts.isJsxAttribute(ancestor.parent) &&
        ancestor.parent.name.getText(file) === "style"
      )
        return true;
      if (ts.isBinaryExpression(ancestor)) {
        if (
          [
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ].includes(ancestor.operatorToken.kind)
        ) {
          // An exact atom being compared is protocol/state data. Do not exempt
          // an entire comparison subtree (which can contain rendered prose).
          if (
            !output.has(node) ||
            ((ancestor.left === node || ancestor.right === node) &&
              ts.isStringLiteral(node) &&
              /^[a-z][A-Za-z0-9_-]*$/.test(node.text))
          )
            return true;
        }
        if (
          ts.isPropertyAccessExpression(ancestor.left) &&
          ancestor.left.name.text === "displayName"
        )
          return true;
      }
      if (ts.isCallExpression(ancestor)) {
        const callee = ancestor.expression.getText(file);
        if (SELECTOR_LITERALS.has(node)) return true;
        return (
          !output.has(node) &&
          /^(?:cn|cva)$|^console\.|\.(?:includes|startsWith|endsWith|replace|split|join|match|test|setItem|getItem|removeItem)$/.test(
            callee,
          )
        );
      }
      return false;
    }),
  );
}

function renderedDependencies(file: ts.SourceFile): Set<ts.Node> {
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === file.fileName ? file : undefined);
  const checker = ts
    .createProgram([file.fileName], options, host)
    .getTypeChecker();
  const output = new Set<ts.Node>();
  const importedAs = (
    expression: ts.Node,
    name: string,
    modules: readonly string[],
  ) =>
    (checker.getSymbolAtLocation(expression)?.declarations ?? []).some(
      (declaration) => {
        if (
          !ts.isImportSpecifier(declaration) ||
          (declaration.propertyName ?? declaration.name).text !== name
        )
          return false;
        const imported = declaration.parent.parent.parent;
        return (
          ts.isImportDeclaration(imported) &&
          ts.isStringLiteral(imported.moduleSpecifier) &&
          modules.includes(imported.moduleSpecifier.text)
        );
      },
    );
  const knownTranslator = (expression: ts.Expression) => {
    if (
      importedAs(expression, "translate", ["@/i18n/translate", "./translate"])
    )
      return true;
    return (checker.getSymbolAtLocation(expression)?.declarations ?? []).some(
      (declaration) => {
        if (
          !ts.isBindingElement(declaration) ||
          (declaration.propertyName ?? declaration.name).getText(file) !== "t"
        )
          return false;
        const variable = declaration.parent.parent;
        return (
          ts.isVariableDeclaration(variable) &&
          variable.initializer &&
          ts.isCallExpression(variable.initializer) &&
          importedAs(variable.initializer.expression, "useTranslation", [
            "react-i18next",
          ])
        );
      },
    );
  };
  const markSelectFlags = (call: ts.CallExpression) => {
    const [key, values] = call.arguments;
    if (
      !key ||
      !ts.isPropertyAccessExpression(key) ||
      !importedAs(key.expression, "MESSAGE_KEYS", [
        "@/i18n/messages",
        "./messages",
      ]) ||
      !values ||
      !ts.isObjectLiteralExpression(values) ||
      !knownTranslator(call.expression)
    )
      return;
    const slots = SELECT_FLAGS[key.name.text] ?? [];
    for (const property of values.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        !slots.includes(property.name.getText(file))
      )
        continue;
      const mark = (node: ts.Node) => {
        if (ts.isStringLiteral(node) && ["yes", "no"].includes(node.text))
          SELECTOR_LITERALS.add(node);
        ts.forEachChild(node, mark);
      };
      mark(property.initializer);
    }
  };
  const returned = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && node.expression) trace(node.expression);
    else if (!ts.isFunctionLike(node)) ts.forEachChild(node, returned);
  };
  const trace = (node: ts.Node) => {
    if (output.has(node)) return;
    if (
      ts.isJsxAttribute(node) &&
      !TEXT_ATTRIBUTES.has(node.name.getText(file))
    )
      return;
    output.add(node);
    if (ts.isCallExpression(node)) {
      markSelectFlags(node);
      const symbol = checker.getSymbolAtLocation(node.expression);
      const declarations = symbol?.declarations ?? [];
      const imported = declarations.find(ts.isImportSpecifier);
      if (
        imported &&
        ["errorKey", "localizedError"].includes(
          (imported.propertyName ?? imported.name).text,
        )
      ) {
        const declaration = imported.parent.parent.parent;
        if (
          ts.isImportDeclaration(declaration) &&
          ts.isStringLiteral(declaration.moduleSpecifier) &&
          ["@/i18n/errors", "./errors"].includes(
            declaration.moduleSpecifier.text,
          )
        ) {
          // These reviewed classifiers never return a backend/native body.
          // Their fallback/key arguments still participate in the audit.
          for (const argument of node.arguments.slice(1)) trace(argument);
          return;
        }
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      let value: ts.Node = node.expression;
      if (ts.isParenthesizedExpression(value)) value = value.expression;
      if (ts.isIdentifier(value)) {
        const declarations =
          checker.getSymbolAtLocation(value)?.declarations ?? [];
        const binding = declarations.find(
          (candidate) =>
            ts.isVariableDeclaration(candidate) ||
            ts.isBindingElement(candidate),
        );
        if (binding && ts.isVariableDeclaration(binding) && binding.initializer)
          value = binding.initializer;
        if (
          binding &&
          ts.isBindingElement(binding) &&
          ts.isVariableDeclaration(binding.parent.parent) &&
          binding.parent.parent.initializer
        )
          value = binding.parent.parent.initializer;
        if (
          ts.isCallExpression(value) &&
          value.expression.getText(file) === "useState" &&
          value.arguments[0]
        )
          value = value.arguments[0];
      }
      if (ts.isObjectLiteralExpression(value)) {
        const member = value.properties.find(
          (property) =>
            property.name?.getText(file).replace(/^['"]|['"]$/g, "") ===
            node.name.text,
        );
        if (member) trace(member);
        return;
      }
    }
    if (ts.isIdentifier(node)) {
      const declarations =
        checker.getSymbolAtLocation(node)?.declarations ?? [];
      for (const declaration of declarations) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer)
          trace(declaration.initializer);
        if (ts.isBindingElement(declaration)) {
          if (declaration.initializer) trace(declaration.initializer);
          const variable = declaration.parent.parent;
          if (ts.isVariableDeclaration(variable) && variable.initializer)
            trace(variable.initializer);
        }
        if (ts.isFunctionDeclaration(declaration) && declaration.body)
          returned(declaration.body);
      }
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      if (ts.isBlock(node.body)) returned(node.body);
      else trace(node.body);
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      trace(node.initializer);
      return;
    }
    if (ts.isGetAccessorDeclaration(node) || ts.isMethodDeclaration(node)) {
      if (node.body) returned(node.body);
      return;
    }
    // Conditions choose an output; their operands are not rendered text.
    if (ts.isConditionalExpression(node)) {
      trace(node.whenTrue);
      trace(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      if (
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
          ts.SyntaxKind.LessThanToken,
          ts.SyntaxKind.GreaterThanToken,
          ts.SyntaxKind.LessThanEqualsToken,
          ts.SyntaxKind.GreaterThanEqualsToken,
        ].includes(node.operatorToken.kind)
      )
        return;
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        trace(node.right);
        return;
      }
    }
    ts.forEachChild(node, trace);
  };
  const isOwnedKeySetter = (node: ts.CallExpression) => {
    if (!ts.isIdentifier(node.expression)) return false;
    return (
      checker.getSymbolAtLocation(node.expression)?.declarations ?? []
    ).some((declaration) => {
      if (
        !ts.isBindingElement(declaration) ||
        !ts.isArrayBindingPattern(declaration.parent) ||
        declaration.parent.elements[1] !== declaration
      )
        return false;
      const variable = declaration.parent.parent;
      if (
        !ts.isVariableDeclaration(variable) ||
        !variable.initializer ||
        !ts.isCallExpression(variable.initializer)
      )
        return false;
      return (
        checker.getSymbolAtLocation(variable.initializer.expression)
          ?.declarations ?? []
      ).some((binding) => {
        if (
          !ts.isImportSpecifier(binding) ||
          (binding.propertyName ?? binding.name).text !== "useMessageError"
        )
          return false;
        const imported = binding.parent.parent.parent;
        return (
          ts.isImportDeclaration(imported) &&
          ts.isStringLiteral(imported.moduleSpecifier) &&
          ["@/i18n/errors", "./errors"].includes(imported.moduleSpecifier.text)
        );
      });
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) markSelectFlags(node);
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (!ts.isJsxAttribute(node.parent) ||
        TEXT_ATTRIBUTES.has(node.parent.name.getText(file)))
    )
      trace(node.expression);
    if (
      ts.isCallExpression(node) &&
      (/^toast\.(?:success|error|info|warning|message|loading)$/.test(
        node.expression.getText(file),
      ) ||
        ((file.fileName.endsWith(".tsx") ||
          file.fileName.startsWith("src/features/")) &&
          /^(?:setError|setLocalError)$/.test(node.expression.getText(file))))
    ) {
      // This hook stores only a catalog key and renders it through t(). Raw
      // strings/errors are never display authority; arbitrary functions merely
      // annotated MessageKey receive no such exemption.
      if (!isOwnedKeySetter(node))
        for (const argument of node.arguments) trace(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return output;
}

/** Reject copy in rendered text/attributes and authored feature presenters.
 * This complements catalog parity: adding a key declaration alone cannot make
 * an untranslated literal pass. It deliberately does not translate errors,
 * fixtures, recovery words, addresses, network names or backend payloads. */
export function untranslatedLiterals(
  sources: Sources,
  closure = productionClosure(sources),
): string[] {
  const failures: string[] = [];
  for (const file of closure) {
    const ast = parse(file, sources[file]);
    const outputNodes = renderedDependencies(ast);
    const presenter =
      file.endsWith(".tsx") ||
      file.startsWith("src/features/") ||
      file === "src/lib/about-copy.ts";
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ["message", "lastError", "diagnostic"].includes(node.name.text) &&
        !isTechnical(node, ast, outputNodes) &&
        outputNodes.has(node)
      ) {
        failures.push(`${file}: raw diagnostic output: ${node.getText(ast)}`);
      }
      let value: string | undefined;
      let directOutput = false;
      if (ts.isJsxText(node)) value = node.text.replace(/\s+/g, " ").trim();
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        const attribute =
          ts.isJsxAttribute(node.parent) &&
          TEXT_ATTRIBUTES.has(node.parent.name.getText(ast));
        const output =
          !isTechnical(node, ast, outputNodes) && outputNodes.has(node);
        directOutput = output;
        const descriptor =
          ts.isPropertyAssignment(node.parent) &&
          TEXT_ATTRIBUTES.has(node.parent.name.getText(ast));
        if (
          attribute ||
          descriptor ||
          output ||
          (presenter && !isTechnical(node, ast, outputNodes))
        )
          value = node.text;
      }
      if (
        ts.isTemplateExpression(node) &&
        presenter &&
        !isTechnical(node, ast, outputNodes)
      ) {
        value = [
          node.head.text,
          ...node.templateSpans.map((part) => part.literal.text),
        ].join(" ");
      }
      if (
        value &&
        !TECHNICAL_VALUES[file]?.includes(value) &&
        hasWords(value) &&
        (directOutput ||
          ts.isJsxText(node) ||
          ts.isJsxAttribute(node.parent) ||
          (ts.isPropertyAssignment(node.parent) &&
            TEXT_ATTRIBUTES.has(node.parent.name.getText(ast))) ||
          sentence(value))
      ) {
        // This frame must work when catalogs/i18next cannot initialize.
        if (!(file === "src/app-bootstrap.tsx" && BOOTSTRAP_COPY.has(value))) {
          const line =
            ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
          failures.push(`${file}:${line}: ${value}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return failures;
}

/** Importing eager or lazy UI modules must not look up messages before the
 * asynchronous locale bootstrap. Static descriptors use getters instead. */
export function eagerTranslations(
  sources: Sources,
  closure = productionClosure(sources),
): string[] {
  const failures: string[] = [];
  for (const file of closure) {
    const ast = parse(file, sources[file]);
    const translators = new Set<string>();
    for (const statement of ast.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !["@/i18n/translate", "./translate"].includes(
          statement.moduleSpecifier.text,
        )
      )
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const item of bindings.elements)
          if ((item.propertyName ?? item.name).text === "translate")
            translators.add(item.name.text);
      }
    }
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        translators.has(node.expression.text) &&
        !ts.findAncestor(node, ts.isFunctionLike)
      )
        failures.push(`${file}: translation evaluated at module scope`);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return failures;
}
