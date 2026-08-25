import { readFile, readdir, realpath, stat } from "node:fs/promises";
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
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "require" &&
        node.expression.name.text === "resolve"
      ) {
        imports.push({ kind: "require.resolve", node: node.arguments[0] });
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

async function existsAs(file, kind) {
  try {
    const info = await stat(file);
    return kind === "file" ? info.isFile() : info.isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function discoverProjects(walletRoot) {
  const projects = [];
  const packageNames = new Set();
  const entries = await readdir(walletRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const projectRoot = path.join(walletRoot, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`wallet project population contains a symbolic link: ${projectRoot}`);
    }
    if (!entry.isDirectory()) continue;
    const manifestFile = path.join(projectRoot, "package.json");
    const sourceRoot = path.join(projectRoot, "src");
    if (!(await existsAs(manifestFile, "file")) || !(await existsAs(sourceRoot, "directory"))) {
      continue;
    }
    const manifest = await readJson(manifestFile);
    if (typeof manifest.name !== "string" || !manifest.name.trim()) {
      throw new Error(`${manifestFile}: wallet source project must declare a package name`);
    }
    if (packageNames.has(manifest.name)) {
      throw new Error(`${manifestFile}: duplicate wallet source-project package name ${manifest.name}`);
    }
    packageNames.add(manifest.name);
    projects.push({
      name: manifest.name,
      directory: entry.name,
      projectRoot,
      sourceRoot,
      manifest,
    });
  }
  if (projects.length === 0) {
    throw new Error("wallet project population contains no package manifest with a src directory");
  }
  return projects;
}

function formatDiagnostic(sourceFile, diagnostic) {
  const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
  return `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
}

function packageSpecifierIsShared(specifier) {
  return specifier === SHARED_PACKAGE || specifier.startsWith(`${SHARED_PACKAGE}/`);
}

function compilerDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
}

function compilerOptions(project) {
  const configFile = path.join(project.projectRoot, "tsconfig.json");
  if (!ts.sys.fileExists(configFile)) return {};
  const diagnostics = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  diagnostics.push(...(parsed?.errors ?? []));
  if (!parsed || diagnostics.length > 0) {
    throw new Error(
      `${configFile}: TypeScript configuration is not auditable: ${diagnostics.map(compilerDiagnostic).join("; ") || "unknown parse failure"}`,
    );
  }
  return parsed.options;
}

function pathPatternMatches(pattern, specifier) {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : null;
  if (pattern.indexOf("*", star + 1) >= 0) return null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : null;
}

function pathAliasViolations(project, options, sharedRoot) {
  const violations = [];
  const paths = options.paths ?? {};
  const base = options.pathsBasePath ?? options.baseUrl ?? project.projectRoot;
  if (options.baseUrl && !inside(project.projectRoot, options.baseUrl)) {
    violations.push(
      `${project.directory}/tsconfig.json: TypeScript baseUrl escapes wallet/${project.directory}`,
    );
  }
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) {
      violations.push(`${project.directory}/tsconfig.json: TypeScript path alias ${pattern} has no targets`);
      continue;
    }
    for (const target of targets) {
      if (typeof target !== "string") {
        violations.push(`${project.directory}/tsconfig.json: TypeScript path alias ${pattern} has a non-string target`);
        continue;
      }
      const staticPrefix = target.split("*", 1)[0];
      const resolved = path.resolve(base, staticPrefix || ".");
      const sharedPattern =
        pattern === SHARED_PACKAGE || pattern === `${SHARED_PACKAGE}/*`;
      if (sharedPattern && !inside(sharedRoot, resolved)) {
        violations.push(
          `${project.directory}/tsconfig.json: named shared TypeScript path alias must resolve inside wallet/shared: ${target}`,
        );
      } else if (!sharedPattern && !inside(project.projectRoot, resolved)) {
        violations.push(
          `${project.directory}/tsconfig.json: TypeScript path alias ${pattern} escapes wallet/${project.directory}: ${target}`,
        );
      }
    }
  }
  return violations;
}

function matchingPathAliases(options, specifier) {
  return Object.entries(options.paths ?? {}).flatMap(([pattern, targets]) => {
    const capture = pathPatternMatches(pattern, specifier);
    return capture === null ? [] : [{ pattern, capture, targets }];
  });
}

function pathAliasImportViolation(project, sharedRoot, specifier, location) {
  const base =
    project.compilerOptions.pathsBasePath ??
    project.compilerOptions.baseUrl ??
    project.projectRoot;
  for (const { pattern, capture, targets } of matchingPathAliases(
    project.compilerOptions,
    specifier,
  )) {
    const sharedPattern =
      pattern === SHARED_PACKAGE || pattern === `${SHARED_PACKAGE}/*`;
    if (packageSpecifierIsShared(specifier) && !sharedPattern) {
      return `${location}: named shared import is shadowed by TypeScript path alias ${pattern}`;
    }
    for (const target of targets) {
      const resolved = path.resolve(base, target.replace("*", capture));
      if (sharedPattern ? !inside(sharedRoot, resolved) : !inside(project.projectRoot, resolved)) {
        return `${location}: TypeScript path alias ${pattern} resolves outside wallet/${project.directory}: ${specifier}`;
      }
    }
  }
  return null;
}

function validateSpecifier({ project, projects, sharedRoot, file, sourceFile, imported, dependencies }) {
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
    const aliasViolation = pathAliasImportViolation(project, sharedRoot, specifier, location);
    if (aliasViolation) return aliasViolation;
    return null;
  }

  const aliasViolation = pathAliasImportViolation(project, sharedRoot, specifier, location);
  if (aliasViolation) return aliasViolation;

  const crossedProject = projects.find(
    (candidate) =>
      candidate.directory !== project.directory &&
      (specifier === candidate.name ||
        specifier.startsWith(`${candidate.name}/`) ||
        specifier === candidate.directory ||
        specifier.startsWith(`${candidate.directory}/`)),
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
  if (!inside(project.projectRoot, target)) {
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
  const projects = await discoverProjects(absoluteWalletRoot);
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
  const shared = projects.find((project) => project.directory === "shared");
  if (!shared) throw new Error("wallet/shared must be a discovered source project");
  if (shared.manifest.name !== SHARED_PACKAGE) {
    throw new Error(`wallet/shared package name must equal ${SHARED_PACKAGE}`);
  }
  if (shared.manifest.private !== true) {
    throw new Error("wallet/shared package must remain private");
  }
  if (shared.manifest.type !== "module") {
    throw new Error('wallet/shared package type must equal "module"');
  }
  if (shared.manifest.exports?.["."] !== "./src/index.ts") {
    throw new Error('wallet/shared package export "." must equal "./src/index.ts"');
  }

  const violations = [];
  const productionSharedConsumers = new Set();
  const requiredSharedDependencyProjects = new Set(
    [...REQUIRED_PRODUCTION_SHARED_CONSUMERS].map((consumer) => consumer.split("/", 1)[0]),
  );
  let fileCount = 0;
  let importCount = 0;
  for (const project of projects) {
    const dependencies = project.manifest.dependencies ?? {};
    project.compilerOptions = compilerOptions(project);
    violations.push(
      ...pathAliasViolations(project, project.compilerOptions, shared.projectRoot),
    );
    if (
      requiredSharedDependencyProjects.has(project.directory) &&
      dependencies[SHARED_PACKAGE] !== "file:../shared"
    ) {
      violations.push(`${project.projectRoot}/package.json: ${project.name} must declare ${SHARED_PACKAGE} as file:../shared`);
    }
    for (const file of await sourceFiles(project.sourceRoot)) {
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
          projects,
          sharedRoot: shared.projectRoot,
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
    projectCount: projects.length,
    projectDirectories: projects.map((project) => project.directory),
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
    `Wallet project boundaries verified across ${result.projectCount} discovered projects, ${result.fileCount} source files, ${result.importCount} parsed module references, and ${result.productionSharedConsumerCount} production shared-package consumers.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
