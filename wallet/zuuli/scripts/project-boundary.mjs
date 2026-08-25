import { lstatSync, realpathSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { loadConfigFromFile, resolveConfig } from "vite";

const SHARED_PACKAGE = "@free2z/wallet-shared";
const executeFile = promisify(execFile);
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CONSTRAINED_VITE_BUILD_HELPER = path.join(
  SCRIPT_DIRECTORY,
  "project-boundary-vite-build.mjs",
);
const BOUNDARY_NODE_MODULES = path.resolve(SCRIPT_DIRECTORY, "../node_modules");
const REQUIRED_PRODUCTION_SHARED_CONSUMERS = new Map([
  [
    "zuuallet/src/lib/sensitive-entry.ts",
    new Map([
      ["SensitiveEntrySession", ["new-assignment:session.current", "type-argument:useRef"]],
      ["bindSensitiveEntryLifecycle", ["return-call"]],
      [
        "SensitiveEntryPurpose",
        [
          "parameter:authority.begin:purpose",
          "parameter:authority.end:purpose",
          "parameter:useSensitiveMnemonicEntry:purpose",
        ],
      ],
    ]),
  ],
  [
    "zuuallet/src/lib/tauri.ts",
    new Map([
      [
        "SensitiveEntryPurpose",
        [
          "parameter:beginSensitiveEntry:purpose",
          "parameter:endSensitiveDisplay:purpose",
        ],
      ],
    ]),
  ],
  [
    "zuuli/src/lib/wallet/bridge.ts",
    new Map([
      [
        "SensitiveEntryPurpose",
        [
          "parameter:wallet.beginSensitiveEntry:purpose",
          "parameter:wallet.endSensitiveDisplay:purpose",
        ],
      ],
    ]),
  ],
  [
    "zuuli/src/lib/wallet/mock.ts",
    new Map([
      [
        "SensitiveEntryPurpose",
        [
          "parameter:mockWallet.beginSensitiveDisplay:purpose",
          "parameter:mockWallet.endSensitiveDisplay:purpose",
          "variable:sensitiveDisplayPurpose",
        ],
      ],
    ]),
  ],
  [
    "zuuli/src/lib/wallet/sensitive-entry.ts",
    new Map([
      ["SensitiveEntrySession", ["new-assignment:session.current", "type-argument:useRef"]],
      ["bindSensitiveEntryLifecycle", ["return-call"]],
      [
        "SensitiveEntryPurpose",
        [
          "parameter:authority.begin:purpose",
          "parameter:authority.end:purpose",
          "parameter:useSensitiveMnemonicEntry:purpose",
        ],
      ],
    ]),
  ],
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

function packageName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/", 1)[0];
}

function projectedRealpath(candidate, label) {
  let current = path.resolve(candidate);
  const missing = [];
  while (true) {
    try {
      const resolved = realpathSync(current);
      if (missing.length > 0 && !statSync(resolved).isDirectory()) {
        throw new Error(`${label} traverses through a non-directory: ${current}`);
      }
      return path.resolve(resolved, ...missing.reverse());
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw new Error(`${label} cannot be resolved without ambiguity: ${error.message}`);
      }
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new Error(`${label} contains a broken symbolic link: ${current}`);
        }
      } catch (linkError) {
        if (linkError.code !== "ENOENT" && linkError.code !== "ENOTDIR") throw linkError;
      }
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`${label} has no resolvable ancestor: ${candidate}`);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function aliasTargetPaths(base, target, capture, label) {
  const firstStar = target.indexOf("*");
  const substituted = firstStar < 0 ? target : target.split("*").join(capture);
  const lexical = path.resolve(base, substituted);
  return { lexical, canonical: projectedRealpath(lexical, `${label} target ${target}`) };
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
    if ((await lstat(sourceRoot)).isSymbolicLink()) {
      throw new Error(`wallet project source root contains a symbolic link: ${sourceRoot}`);
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

function parseTypeScriptConfiguration(project, configFile) {
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
  return { configFile, fileNames: parsed.fileNames, options: parsed.options };
}

async function typeScriptConfigurations(project) {
  const configurations = [];
  const entries = await readdir(project.projectRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!/^tsconfig(?:\.[^.]+)*\.json$/.test(entry.name)) continue;
    const configFile = path.join(project.projectRoot, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`${project.directory}/${entry.name}: TypeScript configuration may not be a symbolic link`);
    }
    if (!entry.isFile()) {
      throw new Error(`${project.directory}/${entry.name}: TypeScript configuration must be a regular file`);
    }
    configurations.push(parseTypeScriptConfiguration(project, configFile));
  }
  return configurations;
}

function typeScriptRootFileViolations(project, configuration, sharedRoot) {
  const violations = [];
  const canonicalProjectRoot = realpathSync(project.projectRoot);
  const canonicalSharedRoot = realpathSync(sharedRoot);
  for (const file of configuration.fileNames) {
    const lexical = path.resolve(file);
    let canonical;
    try {
      canonical = projectedRealpath(
        lexical,
        `${project.directory}/${path.basename(configuration.configFile)} root file`,
      );
    } catch (error) {
      violations.push(error.message);
      continue;
    }
    const ownerLocal =
      inside(project.projectRoot, lexical) && inside(canonicalProjectRoot, canonical);
    const namedShared = inside(sharedRoot, lexical) && inside(canonicalSharedRoot, canonical);
    if (!ownerLocal && !namedShared) {
      violations.push(
        `${project.directory}/${path.basename(configuration.configFile)}: TypeScript root file escapes wallet/${project.directory}: ${file}`,
      );
    }
  }
  return violations;
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

function pathAliasViolations(project, options, sharedRoot, configName) {
  const violations = [];
  const paths = options.paths ?? {};
  const base = options.pathsBasePath ?? options.baseUrl ?? project.projectRoot;
  const canonicalProjectRoot = realpathSync(project.projectRoot);
  const canonicalSharedRoot = realpathSync(sharedRoot);
  const canonicalBase = projectedRealpath(base, `${project.directory}/${configName} base path`);
  if (
    options.baseUrl &&
    (!inside(project.projectRoot, options.baseUrl) ||
      !inside(canonicalProjectRoot, canonicalBase))
  ) {
    violations.push(
      `${project.directory}/${configName}: TypeScript baseUrl escapes wallet/${project.directory}`,
    );
  }
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) {
      violations.push(`${project.directory}/${configName}: TypeScript path alias ${pattern} has no targets`);
      continue;
    }
    for (const target of targets) {
      if (typeof target !== "string") {
        violations.push(`${project.directory}/${configName}: TypeScript path alias ${pattern} has a non-string target`);
        continue;
      }
      const sharedPattern =
        pattern === SHARED_PACKAGE || pattern === `${SHARED_PACKAGE}/*`;
      let targetPaths;
      try {
        targetPaths = aliasTargetPaths(
          base,
          target,
          "__wallet_boundary_probe__",
          `${project.directory}/${configName} path alias ${pattern}`,
        );
      } catch (error) {
        violations.push(error.message);
        continue;
      }
      const boundary = sharedPattern ? sharedRoot : project.projectRoot;
      const canonicalBoundary = sharedPattern ? canonicalSharedRoot : canonicalProjectRoot;
      if (
        !inside(boundary, targetPaths.lexical) ||
        !inside(canonicalBoundary, targetPaths.canonical)
      ) {
        const description = sharedPattern
          ? "named shared TypeScript path alias must resolve inside wallet/shared"
          : `TypeScript path alias ${pattern} escapes wallet/${project.directory}`;
        violations.push(
          `${project.directory}/${configName}: ${description}: ${target}`,
        );
      }
    }
  }
  return violations;
}

function rootDirViolations(project, options, configName) {
  const violations = [];
  const canonicalProjectRoot = realpathSync(project.projectRoot);
  for (const rootDir of options.rootDirs ?? []) {
    const lexical = path.resolve(rootDir);
    let canonical;
    try {
      canonical = projectedRealpath(
        lexical,
        `${project.directory}/${configName} rootDirs entry`,
      );
    } catch (error) {
      violations.push(error.message);
      continue;
    }
    if (
      !inside(project.projectRoot, lexical) ||
      !inside(canonicalProjectRoot, canonical)
    ) {
      violations.push(
        `${project.directory}/${configName}: TypeScript rootDirs entry escapes wallet/${project.directory}: ${rootDir}`,
      );
    }
  }
  return violations;
}

const VITE_CONFIG_NAMES = [
  "vite.config.cjs",
  "vite.config.cts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.mts",
  "vite.config.ts",
];

function normalizedViteAliases(alias) {
  if (alias === undefined) return [];
  if (Array.isArray(alias)) return alias;
  if (alias && typeof alias === "object") {
    return Object.entries(alias).map(([find, replacement]) => ({
      find,
      replacement,
    }));
  }
  throw new Error("resolve.alias must be an object or array");
}

async function normalizedVitePlugins(option) {
  const resolved = await option;
  if (!resolved) return [];
  if (Array.isArray(resolved)) {
    const plugins = [];
    for (const nested of resolved) plugins.push(...(await normalizedVitePlugins(nested)));
    return plugins;
  }
  if (typeof resolved !== "object") throw new Error("plugins must resolve to plugin objects");
  return [resolved];
}

function viteInputEntries(value, label) {
  if (value === undefined || value === false) return [];
  if (typeof value === "string") return [{ label, value }];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => viteInputEntries(entry, `${label}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([name, entry]) =>
      viteInputEntries(entry, `${label}.${name}`),
    );
  }
  throw new Error(`${label} must contain only filesystem path strings`);
}

function viteFilesystemViolation(
  project,
  sharedRoot,
  candidate,
  label,
  { allowShared = true } = {},
) {
  const query = candidate.search(/[?#]/);
  let identifier = query < 0 ? candidate : candidate.slice(0, query);
  if (identifier.startsWith("\0")) return `${label} resolves to an opaque virtual module`;
  if (identifier.startsWith("file:")) {
    try {
      identifier = fileURLToPath(identifier);
    } catch (error) {
      return `${label} has an invalid file URL: ${error.message}`;
    }
  } else if (identifier.startsWith("/@fs/")) {
    identifier = identifier.slice(4);
  }
  if (!path.isAbsolute(identifier)) {
    return `${label} resolves to a non-filesystem module id: ${candidate}`;
  }
  const lexical = path.resolve(identifier);
  let canonical;
  try {
    canonical = projectedRealpath(lexical, label);
  } catch (error) {
    return error.message;
  }
  const canonicalProjectRoot = realpathSync(project.projectRoot);
  const canonicalSharedRoot = realpathSync(sharedRoot);
  const ownerLocal = inside(project.projectRoot, lexical) && inside(canonicalProjectRoot, canonical);
  const namedShared = inside(sharedRoot, lexical) && inside(canonicalSharedRoot, canonical);
  return ownerLocal || (allowShared && namedShared)
    ? null
    : `${label} escapes wallet/${project.directory}: ${candidate}`;
}

function viteInputViolations(project, sharedRoot, resolved) {
  const violations = [];
  const configName = path.basename(resolved.configFile);
  for (const [label, candidate] of [
    ["root", resolved.root],
    ["publicDir", resolved.publicDir === false ? undefined : resolved.publicDir],
  ]) {
    if (candidate === undefined) continue;
    const violation = viteFilesystemViolation(
      project,
      sharedRoot,
      path.resolve(project.projectRoot, candidate),
      `${project.directory}/${configName} Vite ${label}`,
      { allowShared: false },
    );
    if (violation) violations.push(violation);
  }
  const inputs = [
    ...viteInputEntries(resolved.build?.rollupOptions?.input, "build.rollupOptions.input"),
    ...viteInputEntries(resolved.build?.lib?.entry, "build.lib.entry"),
    ...viteInputEntries(
      typeof resolved.build?.ssr === "string" ? resolved.build.ssr : undefined,
      "build.ssr",
    ),
  ];
  for (const input of inputs) {
    const violation = viteFilesystemViolation(
      project,
      sharedRoot,
      path.resolve(resolved.root, input.value),
      `${project.directory}/${configName} Vite ${input.label}`,
    );
    if (violation) violations.push(violation);
  }
  return violations;
}

function viteResolveHandler(plugin) {
  if (typeof plugin.resolveId === "function") return plugin.resolveId;
  if (plugin.resolveId && typeof plugin.resolveId === "object" && typeof plugin.resolveId.handler === "function") {
    return plugin.resolveId.handler;
  }
  if (plugin.resolveId === undefined) return null;
  throw new Error(`plugin ${plugin.name ?? "<unnamed>"} has an unauditable resolveId hook`);
}

async function constrainedViteBuildViolation(project, sharedRoot, configFile) {
  if (!(await existsAs(BOUNDARY_NODE_MODULES, "directory"))) {
    return `${project.directory}/${path.basename(configFile)}: constrained Vite graph build requires ${BOUNDARY_NODE_MODULES}`;
  }
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "wallet-boundary-vite-"));
  const allowedReadRoots = await Promise.all([
    project.projectRoot,
    sharedRoot,
    path.join(path.dirname(project.projectRoot), "package.json"),
    BOUNDARY_NODE_MODULES,
    CONSTRAINED_VITE_BUILD_HELPER,
    outputRoot,
  ].map((root) => realpath(root)));
  const allowedWriteRoot = await realpath(outputRoot);
  try {
    await executeFile(
      process.execPath,
      [
        "--permission",
        "--experimental-strip-types",
        "--allow-addons",
        ...allowedReadRoots.map((root) => `--allow-fs-read=${root}`),
        `--allow-fs-write=${allowedWriteRoot}`,
        CONSTRAINED_VITE_BUILD_HELPER,
        project.projectRoot,
        configFile,
        allowedWriteRoot,
        JSON.stringify(allowedReadRoots),
      ],
      {
        cwd: project.projectRoot,
        env: { ...process.env, NODE_OPTIONS: "" },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return null;
  } catch (error) {
    const detail = [error.stderr, error.stdout, error.message]
      .filter((part) => typeof part === "string" && part.trim())
      .join("\n")
      .trim();
    return `${project.directory}/${path.basename(configFile)}: constrained production Vite graph build failed; a plugin or module may have read outside wallet/${project.directory} and wallet/shared: ${detail}`;
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

async function viteConfigurationViolations(
  project,
  sharedRoot,
  moduleReferences,
  { verifyBuildGraph = false, statistics } = {},
) {
  const configFiles = [];
  for (const name of VITE_CONFIG_NAMES) {
    const candidate = path.join(project.projectRoot, name);
    if (await existsAs(candidate, "file")) configFiles.push(candidate);
  }
  if (configFiles.length > 1) {
    return [
      `${project.directory}: Vite configuration is ambiguous: ${configFiles.map(path.basename).join(", ")}`,
    ];
  }
  if (configFiles.length === 0) return [];
  const configFile = configFiles[0];
  if ((await lstat(configFile)).isSymbolicLink()) {
    return [`${project.directory}: Vite configuration may not be a symbolic link: ${configFile}`];
  }

  const violations = [];
  const canonicalProjectRoot = realpathSync(project.projectRoot);
  const canonicalSharedRoot = realpathSync(sharedRoot);
  for (const environment of [
    { command: "build", mode: "production" },
    { command: "serve", mode: "development" },
  ]) {
    let loaded;
    let resolved;
    try {
      loaded = await loadConfigFromFile(
        {
          command: environment.command,
          mode: environment.mode,
          isSsrBuild: false,
          isPreview: false,
        },
        configFile,
        project.projectRoot,
        "silent",
      );
      resolved = await resolveConfig(
        { configFile, logLevel: "silent", mode: environment.mode, root: project.projectRoot },
        environment.command,
        environment.mode,
      );
    } catch (error) {
      violations.push(
        `${project.directory}/${path.basename(configFile)}: Vite ${environment.command} configuration is not auditable: ${error.message}`,
      );
      continue;
    }
    try {
      violations.push(...viteInputViolations(project, sharedRoot, resolved));
    } catch (error) {
      violations.push(
        `${project.directory}/${path.basename(configFile)}: Vite ${environment.command} inputs are not auditable: ${error.message}`,
      );
    }
    let aliases;
    try {
      aliases = normalizedViteAliases(loaded?.config?.resolve?.alias);
    } catch (error) {
      violations.push(
        `${project.directory}/${path.basename(configFile)}: ${error.message}`,
      );
      continue;
    }
    for (const alias of aliases) {
      if (
        !alias ||
        typeof alias !== "object" ||
        typeof alias.find !== "string" ||
        alias.find.length === 0 ||
        typeof alias.replacement !== "string" ||
        alias.replacement.length === 0 ||
        alias.customResolver !== undefined
      ) {
        violations.push(
          `${project.directory}/${path.basename(configFile)}: Vite alias entries must use auditable string find/replacement pairs without custom resolvers`,
        );
        continue;
      }
      if (
        !path.isAbsolute(alias.replacement) &&
        !alias.replacement.startsWith(".")
      ) {
        violations.push(
          `${project.directory}/${path.basename(configFile)}: Vite alias ${alias.find} must use a filesystem replacement`,
        );
        continue;
      }
      const lexical = path.resolve(project.projectRoot, alias.replacement);
      let canonical;
      try {
        canonical = projectedRealpath(
          lexical,
          `${project.directory}/${path.basename(configFile)} Vite alias ${alias.find}`,
        );
      } catch (error) {
        violations.push(error.message);
        continue;
      }
      const sharedAlias = alias.find === SHARED_PACKAGE;
      const boundary = sharedAlias ? sharedRoot : project.projectRoot;
      const canonicalBoundary = sharedAlias
        ? canonicalSharedRoot
        : canonicalProjectRoot;
      if (
        !inside(boundary, lexical) ||
        !inside(canonicalBoundary, canonical)
      ) {
        violations.push(
          `${project.directory}/${path.basename(configFile)}: Vite alias ${alias.find} escapes wallet/${project.directory}: ${alias.replacement}`,
        );
      }
    }
    const resolver = resolved.createResolver();
    for (const reference of moduleReferences) {
      let standard;
      try {
        standard = await resolver(reference.specifier, reference.importer);
      } catch (error) {
        violations.push(
          `${reference.location}: Vite ${environment.command} resolution is not auditable: ${error.message}`,
        );
        continue;
      }
      if (standard) {
        const violation = viteFilesystemViolation(
          project,
          sharedRoot,
          typeof standard === "string" ? standard : standard.id,
          `${reference.location} Vite ${environment.command} resolution of ${reference.specifier}`,
        );
        if (violation) violations.push(violation);
      }
    }
    let plugins;
    try {
      plugins = await normalizedVitePlugins([
        loaded?.config?.plugins,
        loaded?.config?.build?.rollupOptions?.plugins,
      ]);
    } catch (error) {
      violations.push(
        `${project.directory}/${path.basename(configFile)}: Vite plugins are not auditable: ${error.message}`,
      );
      continue;
    }
    const pluginContext = new Proxy(
      {
        async resolve(specifier, importer) {
          const id = await resolver(specifier, importer);
          return id ? { id: typeof id === "string" ? id : id.id } : null;
        },
      },
      {
        get(target, property) {
          if (property in target) return target[property];
          throw new Error(`unsupported Rollup plugin context member ${String(property)}`);
        },
      },
    );
    for (const plugin of plugins) {
      let handler;
      try {
        handler = viteResolveHandler(plugin);
      } catch (error) {
        violations.push(`${project.directory}/${path.basename(configFile)}: ${error.message}`);
        continue;
      }
      if (!handler) continue;
      for (const reference of moduleReferences) {
        let result;
        try {
          result = await handler.call(
            pluginContext,
            reference.specifier,
            reference.importer,
            { attributes: {}, custom: {}, isEntry: false },
          );
        } catch (error) {
          violations.push(
            `${reference.location}: Vite plugin ${plugin.name ?? "<unnamed>"} resolveId is not independently auditable: ${error.message}`,
          );
          continue;
        }
        if (!result) continue;
        const resolvedId = typeof result === "string" ? result : result.id;
        if (typeof resolvedId !== "string" || resolvedId.length === 0) {
          violations.push(
            `${reference.location}: Vite plugin ${plugin.name ?? "<unnamed>"} returned an unauditable module id`,
          );
          continue;
        }
        const candidate = path.isAbsolute(resolvedId)
          ? resolvedId
          : resolvedId.startsWith(".")
            ? path.resolve(path.dirname(reference.importer), resolvedId)
            : resolvedId;
        const violation = viteFilesystemViolation(
          project,
          sharedRoot,
          candidate,
          `${reference.location} Vite plugin ${plugin.name ?? "<unnamed>"} resolution of ${reference.specifier}`,
        );
        if (violation) violations.push(violation);
      }
    }
    if (verifyBuildGraph && environment.command === "build") {
      const violation = await constrainedViteBuildViolation(
        project,
        sharedRoot,
        configFile,
      );
      if (violation) violations.push(violation);
      else statistics.viteBuildsVerified += 1;
    }
  }
  return [...new Set(violations)];
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
      let targetPaths;
      try {
        targetPaths = aliasTargetPaths(
          base,
          target,
          capture,
          `${project.directory}/tsconfig.json path alias ${pattern}`,
        );
      } catch (error) {
        return `${location}: ${error.message}`;
      }
      const boundary = sharedPattern ? sharedRoot : project.projectRoot;
      if (
        !inside(boundary, targetPaths.lexical) ||
        !inside(realpathSync(boundary), targetPaths.canonical)
      ) {
        return `${location}: TypeScript path alias ${pattern} resolves outside wallet/${project.directory}: ${specifier}`;
      }
    }
  }
  return null;
}

function dependencySections(manifest) {
  return [
    ["dependencies", manifest.dependencies ?? {}],
    ["devDependencies", manifest.devDependencies ?? {}],
    ["optionalDependencies", manifest.optionalDependencies ?? {}],
    ["peerDependencies", manifest.peerDependencies ?? {}],
  ];
}

function dependencyViolations(project, projects) {
  const violations = [];
  for (const [section, dependencies] of dependencySections(project.manifest)) {
    for (const [alias, value] of Object.entries(dependencies)) {
      if (alias === SHARED_PACKAGE && section === "dependencies" && value === "file:../shared") {
        continue;
      }
      if (typeof value !== "string") {
        violations.push(`${project.projectRoot}/package.json: ${section}.${alias} must be a string`);
        continue;
      }
      const local = /^(file|link|workspace):(.*)$/.exec(value);
      const implicitLocal =
        value.startsWith("./") ||
        value.startsWith("../") ||
        path.isAbsolute(value) ||
        /^[A-Za-z]:[\\/]/.test(value);
      if (local || implicitLocal) {
        const protocol = local?.[1] ?? "local path";
        const localTarget = local?.[2] ?? value;
        if (protocol !== "workspace") {
          try {
            projectedRealpath(
              path.resolve(project.projectRoot, localTarget),
              `${project.directory}/package.json ${section}.${alias}`,
            );
          } catch (error) {
            violations.push(error.message);
            continue;
          }
        }
        violations.push(
          `${project.projectRoot}/package.json: non-shared dependency alias ${section}.${alias} may not use ${protocol}`,
        );
        continue;
      }
      const npmAlias = /^npm:(@[^/]+\/[^@]+|[^@/]+)(?:@.+)?$/.exec(value)?.[1];
      const crossedProject = npmAlias
        ? projects.find(
            (candidate) =>
              candidate.directory !== project.directory &&
              (npmAlias === candidate.name || npmAlias === candidate.directory),
          )
        : null;
      if (crossedProject) {
        violations.push(
          `${project.projectRoot}/package.json: dependency alias ${alias} resolves to wallet/${crossedProject.directory}`,
        );
      }
    }
  }
  return violations;
}

function sharedImportBindings(sourceFile, checker) {
  const declarations = sourceFile.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      literalModule(statement.moduleSpecifier) === SHARED_PACKAGE,
  );
  if (declarations.length !== 1) return null;
  const clause = declarations[0].importClause;
  if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    return null;
  }
  const bindings = new Map();
  for (const element of clause.namedBindings.elements) {
    if (element.propertyName || bindings.has(element.name.text)) return null;
    const symbol = checker.getSymbolAtLocation(element.name);
    if (!symbol) return null;
    bindings.set(element.name.text, {
      kind: clause.isTypeOnly || element.isTypeOnly ? "type" : "value",
      symbol,
    });
  }
  return bindings;
}

function enclosingParameterOwner(parameter, sourceFile) {
  for (let current = parameter.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text ?? "anonymous";
    if (ts.isArrowFunction(current) && ts.isPropertyAssignment(current.parent)) {
      let owner = current.parent.parent;
      while (owner && !ts.isVariableDeclaration(owner)) owner = owner.parent;
      const objectName = owner?.name?.getText(sourceFile);
      return `${objectName ? `${objectName}.` : ""}${current.parent.name.getText(sourceFile)}`;
    }
    if (ts.isMethodDeclaration(current)) {
      let owner = current.parent;
      while (owner && !ts.isVariableDeclaration(owner)) owner = owner.parent;
      const objectName = owner?.name?.getText(sourceFile);
      return `${objectName ? `${objectName}.` : ""}${current.name.getText(sourceFile)}`;
    }
    if (ts.isPropertySignature(current)) {
      let owner = current.parent;
      while (owner && !ts.isInterfaceDeclaration(owner)) owner = owner.parent;
      const interfaceName = owner?.name?.text;
      return `${interfaceName ? `${interfaceName}.` : ""}${current.name.getText(sourceFile)}`;
    }
  }
  return "unknown";
}

function semanticBindingUse(identifier, sourceFile) {
  const parent = identifier.parent;
  if (ts.isNewExpression(parent) && parent.expression === identifier) {
    for (let current = parent.parent; current; current = current.parent) {
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return `new-assignment:${current.left.getText(sourceFile)}`;
      }
      if (ts.isStatement(current)) break;
    }
    return "new-unassigned";
  }
  if (ts.isCallExpression(parent) && parent.expression === identifier) {
    for (let current = parent.parent; current; current = current.parent) {
      if (ts.isReturnStatement(current)) return "return-call";
      if (ts.isStatement(current)) break;
    }
    return "call-unreturned";
  }
  for (let current = parent; current; current = current.parent) {
    if (ts.isParameter(current)) {
      return `parameter:${enclosingParameterOwner(current, sourceFile)}:${current.name.getText(sourceFile)}`;
    }
    if (ts.isCallExpression(current) && current.typeArguments?.some(
      (argument) => argument.pos <= identifier.pos && argument.end >= identifier.end,
    )) {
      return `type-argument:${current.expression.getText(sourceFile)}`;
    }
    if (ts.isVariableDeclaration(current)) {
      return `variable:${current.name.getText(sourceFile)}`;
    }
  }
  return `other:${ts.SyntaxKind[parent.kind]}`;
}

function sharedBindingUses(sourceFile, bindings, checker) {
  const names = bindings.keys();
  const uses = new Map([...names].map((name) => [name, []]));
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return;
    if (
      ts.isIdentifier(node) &&
      uses.has(node.text) &&
      checker.getSymbolAtLocation(node) === bindings.get(node.text).symbol
    ) {
      uses.get(node.text).push(semanticBindingUse(node, sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const value of uses.values()) value.sort();
  return uses;
}

function productionSharedConsumerViolation(relativeFile, sourceFile, checker) {
  const expected = REQUIRED_PRODUCTION_SHARED_CONSUMERS.get(relativeFile);
  if (!expected) return null;
  const bindings = sharedImportBindings(sourceFile, checker);
  if (!bindings) {
    return `${relativeFile}: production consumer must have one auditable named import from ${SHARED_PACKAGE}`;
  }
  const expectedNames = [...expected.keys()].sort();
  if (JSON.stringify([...bindings.keys()].sort()) !== JSON.stringify(expectedNames)) {
    return `${relativeFile}: production consumer must import exactly ${expectedNames.join(", ")} from ${SHARED_PACKAGE}`;
  }
  for (const [name, kinds] of expected) {
    const expectedImportKind = name === "SensitiveEntryPurpose" ? "type" : "value";
    if (bindings.get(name).kind !== expectedImportKind) {
      return `${relativeFile}: ${name} must be a ${expectedImportKind}-only named binding`;
    }
  }
  const uses = sharedBindingUses(sourceFile, bindings, checker);
  for (const [name, kinds] of expected) {
    const actual = uses.get(name);
    const sortedExpected = [...kinds].sort();
    if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
      return `${relativeFile}: shared binding ${name} must have exact uses ${sortedExpected.join(", ")}; found ${actual.join(", ") || "none"}`;
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
    if (specifier !== SHARED_PACKAGE) {
      return `${location}: ${SHARED_PACKAGE} exposes only its package root: ${specifier}`;
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
      (packageName(specifier) === candidate.name || packageName(specifier) === candidate.directory),
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

export async function scanProjectBoundaries(
  walletRoot,
  { verifyViteBuildGraph = false } = {},
) {
  const statistics = { viteBuildsVerified: 0 };
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
  if (
    !shared.manifest.exports ||
    Array.isArray(shared.manifest.exports) ||
    typeof shared.manifest.exports !== "object" ||
    JSON.stringify(shared.manifest.exports) !== JSON.stringify({ ".": "./src/index.ts" })
  ) {
    throw new Error(
      'wallet/shared package exports must equal exactly {".":"./src/index.ts"}',
    );
  }

  const violations = [];
  const productionSharedConsumers = new Set();
  const requiredSharedDependencyProjects = new Set(
    [...REQUIRED_PRODUCTION_SHARED_CONSUMERS.keys()].map((consumer) => consumer.split("/", 1)[0]),
  );
  let fileCount = 0;
  let importCount = 0;
  for (const project of projects) {
    const dependencies = project.manifest.dependencies ?? {};
    const configurations = await typeScriptConfigurations(project);
    const primaryConfiguration = configurations.find(
      (configuration) => path.basename(configuration.configFile) === "tsconfig.json",
    );
    project.compilerOptions = primaryConfiguration?.options ?? {};
    violations.push(...dependencyViolations(project, projects));
    for (const configuration of configurations) {
      const configName = path.basename(configuration.configFile);
      violations.push(
        ...rootDirViolations(project, configuration.options, configName),
        ...pathAliasViolations(project, configuration.options, shared.projectRoot, configName),
        ...typeScriptRootFileViolations(project, configuration, shared.projectRoot),
      );
    }
    if (
      requiredSharedDependencyProjects.has(project.directory) &&
      dependencies[SHARED_PACKAGE] !== "file:../shared"
    ) {
      violations.push(`${project.projectRoot}/package.json: ${project.name} must declare ${SHARED_PACKAGE} as file:../shared`);
    }
    const projectFiles = await sourceFiles(project.sourceRoot);
    const program = ts.createProgram(projectFiles, {
      ...project.compilerOptions,
      allowJs: true,
      noEmit: true,
    });
    const checker = program.getTypeChecker();
    const moduleReferences = [];
    for (const file of projectFiles) {
      fileCount += 1;
      const source = await readFile(file, "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, scriptKind(file));
      if (parsed.parseDiagnostics.length > 0) {
        violations.push(...parsed.parseDiagnostics.map((diagnostic) => formatDiagnostic(parsed, diagnostic)));
        continue;
      }
      const relativeFile = path.relative(absoluteWalletRoot, file).split(path.sep).join("/");
      const consumerSource = REQUIRED_PRODUCTION_SHARED_CONSUMERS.has(relativeFile)
        ? program.getSourceFile(file)
        : parsed;
      if (REQUIRED_PRODUCTION_SHARED_CONSUMERS.has(relativeFile) && !consumerSource) {
        violations.push(`${relativeFile}: production consumer is absent from the TypeScript program`);
      }
      const consumerViolation = consumerSource
        ? productionSharedConsumerViolation(relativeFile, consumerSource, checker)
        : null;
      if (consumerViolation) violations.push(consumerViolation);
      else if (consumerSource && REQUIRED_PRODUCTION_SHARED_CONSUMERS.has(relativeFile)) {
        productionSharedConsumers.add(relativeFile);
      }
      for (const imported of importedModules(parsed)) {
        importCount += 1;
        const literal = literalModule(imported.node);
        if (literal !== null) {
          const position = parsed.getLineAndCharacterOfPosition(imported.node.getStart(parsed));
          moduleReferences.push({
            importer: file,
            location: `${file}:${position.line + 1}:${position.character + 1}`,
            specifier: literal,
          });
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
    violations.push(
      ...(await viteConfigurationViolations(
        project,
        shared.projectRoot,
        moduleReferences,
        { verifyBuildGraph: verifyViteBuildGraph, statistics },
      )),
    );
  }
  for (const required of REQUIRED_PRODUCTION_SHARED_CONSUMERS.keys()) {
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
    viteBuildsVerified: statistics.viteBuildsVerified,
    violations,
  };
}

export async function assertProjectBoundaries(walletRoot, options) {
  const result = await scanProjectBoundaries(walletRoot, options);
  if (result.violations.length > 0) throw new Error(result.violations.join("\n"));
  return result;
}

export async function main({
  walletRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
} = {}) {
  const result = await assertProjectBoundaries(walletRoot, {
    verifyViteBuildGraph: true,
  });
  console.log(
    `Wallet project boundaries verified across ${result.projectCount} discovered projects, ${result.fileCount} source files, ${result.importCount} parsed module references, ${result.productionSharedConsumerCount} production shared-package consumers, and ${result.viteBuildsVerified} constrained production Vite builds.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
