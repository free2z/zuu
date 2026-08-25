import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SHARED_PACKAGE = "@free2z/wallet-shared";
const REQUIRED_PRODUCTION_SHARED_CONSUMERS = new Set([
  "zuuallet/src/lib/sensitive-entry.ts",
  "zuuallet/src/lib/tauri.ts",
  "zuuli/src/lib/wallet/bridge.ts",
  "zuuli/src/lib/wallet/mock.ts",
  "zuuli/src/lib/wallet/sensitive-entry.ts",
]);
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const PROJECTS = [
  { name: "zuuli", directory: "zuuli", sourceDirectory: "src", aliases: ["@/"], consumesShared: true },
  { name: "zuuallet", directory: "zuuallet", sourceDirectory: "src", aliases: [], consumesShared: true },
  { name: "shared", directory: "shared", sourceDirectory: "src", aliases: [], consumesShared: false },
];

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function scriptKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function literalModule(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null;
}

function importedModules(sourceFile) {
  const imports = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        imports.push({ kind: ts.isImportDeclaration(node) ? "import" : "export", node: node.moduleSpecifier });
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      imports.push({ kind: "import-equals", node: node.moduleReference.expression });
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        imports.push({ kind: "dynamic import", node: node.arguments[0] });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        imports.push({ kind: "require", node: node.arguments[0] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

async function sourceFiles(root) {
  const files = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`project source contains a symbolic link: ${absolute}`);
      }
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(absolute);
    }
  };
  await walk(root);
  return files;
}

function formatDiagnostic(sourceFile, diagnostic) {
  const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
  return `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
}

function packageSpecifierIsShared(specifier) {
  return specifier === SHARED_PACKAGE || specifier.startsWith(`${SHARED_PACKAGE}/`);
}

function validateSpecifier({ project, projectRoot, sourceRoot, file, sourceFile, imported, dependencies }) {
  const position = sourceFile.getLineAndCharacterOfPosition(imported.node?.getStart(sourceFile) ?? 0);
  const location = `${file}:${position.line + 1}:${position.character + 1}`;
  if (!imported.node) return `${location}: ${imported.kind} has no module specifier`;
  const specifier = literalModule(imported.node);
  if (specifier === null) {
    return `${location}: ${imported.kind} must use a statically auditable module specifier`;
  }
  if (specifier.includes("\0")) return `${location}: module specifier contains NUL`;

  if (packageSpecifierIsShared(specifier)) {
    if (specifier.split("/").includes("..")) {
      return `${location}: shared package import may not traverse parent segments: ${specifier}`;
    }
    if (dependencies[SHARED_PACKAGE] !== "file:../shared") {
      return `${location}: ${project.name} imports ${SHARED_PACKAGE} without its exact declared dependency`;
    }
    return null;
  }

  const alias = project.aliases.find((prefix) => specifier.startsWith(prefix));
  if (alias) {
    const target = path.resolve(sourceRoot, specifier.slice(alias.length));
    return inside(sourceRoot, target)
      ? null
      : `${location}: local alias escapes ${project.name}/src: ${specifier}`;
  }

  const crossedProject = PROJECTS.find(
    (candidate) =>
      candidate.name !== project.name &&
      (specifier === candidate.name || specifier.startsWith(`${candidate.name}/`)),
  );
  if (crossedProject) {
    return `${location}: ${project.name} imports the ${crossedProject.name} application as a package: ${specifier}`;
  }
  if (
    specifier.startsWith("file:") ||
    /^[A-Za-z]:[\\/]/.test(specifier) ||
    specifier.startsWith("\\\\")
  ) {
    return `${location}: absolute source import is forbidden: ${specifier}`;
  }
  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) return null;
  if (path.isAbsolute(specifier)) {
    return `${location}: absolute source import is forbidden: ${specifier}`;
  }
  const target = path.resolve(path.dirname(file), specifier.split(/[?#]/, 1)[0]);
  if (!inside(projectRoot, target)) {
    return `${location}: relative import escapes wallet/${project.directory}: ${specifier}`;
  }
  return null;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: invalid JSON: ${error.message}`);
  }
}

export async function scanProjectBoundaries(walletRoot) {
  const absoluteWalletRoot = await realpath(walletRoot);
  const workspace = await readJson(path.join(absoluteWalletRoot, "package.json"));
  if (
    !Array.isArray(workspace.workspaces) ||
    workspace.workspaces.length !== 1 ||
    workspace.workspaces[0] !== "shared"
  ) {
    throw new Error("wallet/package.json must declare the exact shared workspace");
  }
  const workspaceLock = await readJson(path.join(absoluteWalletRoot, "package-lock.json"));
  const sharedLink = workspaceLock.packages?.[`node_modules/${SHARED_PACKAGE}`];
  if (sharedLink?.link !== true || sharedLink.resolved !== "shared") {
    throw new Error("wallet/package-lock.json must resolve the named shared workspace as a local link");
  }
  const sharedManifest = await readJson(path.join(absoluteWalletRoot, "shared/package.json"));
  if (
    sharedManifest.name !== SHARED_PACKAGE ||
    sharedManifest.private !== true ||
    sharedManifest.type !== "module" ||
    sharedManifest.exports?.["."] !== "./src/index.ts"
  ) {
    throw new Error(
      "wallet/shared must retain its private ESM @free2z/wallet-shared package identity and source export",
    );
  }

  const violations = [];
  const productionSharedConsumers = new Set();
  let fileCount = 0;
  let importCount = 0;
  for (const project of PROJECTS) {
    const projectRoot = path.join(absoluteWalletRoot, project.directory);
    const sourceRoot = path.join(projectRoot, project.sourceDirectory);
    const manifest = await readJson(path.join(projectRoot, "package.json"));
    const dependencies = manifest.dependencies ?? {};
    if (project.consumesShared && dependencies[SHARED_PACKAGE] !== "file:../shared") {
      violations.push(`${projectRoot}/package.json: ${project.name} must declare ${SHARED_PACKAGE} as file:../shared`);
    }
    for (const file of await sourceFiles(sourceRoot)) {
      fileCount += 1;
      const source = await readFile(file, "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, scriptKind(file));
      if (parsed.parseDiagnostics.length > 0) {
        violations.push(...parsed.parseDiagnostics.map((diagnostic) => formatDiagnostic(parsed, diagnostic)));
        continue;
      }
      for (const imported of importedModules(parsed)) {
        importCount += 1;
        const specifier = imported.node ? literalModule(imported.node) : null;
        const relativeFile = path.relative(absoluteWalletRoot, file).split(path.sep).join("/");
        if (
          specifier === SHARED_PACKAGE &&
          REQUIRED_PRODUCTION_SHARED_CONSUMERS.has(relativeFile)
        ) {
          productionSharedConsumers.add(relativeFile);
        }
        const violation = validateSpecifier({
          project,
          projectRoot,
          sourceRoot,
          file,
          sourceFile: parsed,
          imported,
          dependencies,
        });
        if (violation) violations.push(violation);
      }
    }
  }
  for (const required of REQUIRED_PRODUCTION_SHARED_CONSUMERS) {
    if (!productionSharedConsumers.has(required)) {
      violations.push(`${required}: production consumer must import ${SHARED_PACKAGE}`);
    }
  }
  return {
    fileCount,
    importCount,
    productionSharedConsumerCount: productionSharedConsumers.size,
    violations,
  };
}

export async function assertProjectBoundaries(walletRoot) {
  const result = await scanProjectBoundaries(walletRoot);
  if (result.violations.length > 0) throw new Error(result.violations.join("\n"));
  return result;
}

export async function main() {
  const walletRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const result = await assertProjectBoundaries(walletRoot);
  console.log(
    `Wallet project boundaries verified across ${result.fileCount} source files, ${result.importCount} parsed module references, and ${result.productionSharedConsumerCount} production shared-package consumers.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
