import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [
  projectRootArgument,
  sharedRootArgument,
  configFileArgument,
  outputDirectoryArgument,
  allowedRootsJson,
  requestFileArgument,
  resultFileArgument,
  operation,
] = process.argv.slice(2);
if (path.resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) {
  throw new Error(
    "the constrained Vite build helper must run as its entry point",
  );
}
if (
  !projectRootArgument ||
  !sharedRootArgument ||
  !configFileArgument ||
  !outputDirectoryArgument ||
  !allowedRootsJson ||
  !requestFileArgument ||
  !resultFileArgument ||
  !["audit-only", "build"].includes(operation)
) {
  throw new Error(
    "expected project root, shared root, Vite config, output directory, allowed read roots, request, result, and operation",
  );
}

const projectRoot = fs.realpathSync(projectRootArgument);
const sharedRoot = fs.realpathSync(sharedRootArgument);
const configFile = fs.realpathSync(configFileArgument);
const outputDirectory = fs.realpathSync(outputDirectoryArgument);
const auditDirectory = fs.realpathSync(path.dirname(outputDirectory));
const requestFile = fs.realpathSync(requestFileArgument);
const resultFile = path.join(
  fs.realpathSync(path.dirname(resultFileArgument)),
  path.basename(resultFileArgument),
);

const allowedRoots = JSON.parse(allowedRootsJson).map((root) =>
  path.resolve(root),
);
allowedRoots.push(outputDirectory);
const boundaryNodeModules = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../node_modules",
);
globalThis.__dirname = path.dirname(configFile);
globalThis.__filename = configFile;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

if (
  !inside(auditDirectory, requestFile) ||
  !inside(auditDirectory, resultFile) ||
  requestFile === resultFile
) {
  throw new Error("audit request and result must be distinct output-local files");
}

function auditedPath(candidate, operation) {
  if (typeof candidate === "number") return candidate;
  const lexical =
    candidate instanceof URL
      ? fileURLToPath(candidate)
      : path.resolve(candidate);
  let canonical;
  try {
    canonical = fs.realpathSync.native(lexical);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    canonical = lexical;
  }
  if (!allowedRoots.some((root) => inside(root, canonical))) {
    const denied = new Error(
      `wallet project boundary denied ${operation} outside the owner/shared graph: ${canonical}`,
    );
    denied.code = "ERR_WALLET_PROJECT_BOUNDARY";
    throw denied;
  }
  return candidate;
}

for (const name of [
  "readFileSync",
  "openSync",
  "createReadStream",
  "readlinkSync",
]) {
  const original = fs[name].bind(fs);
  fs[name] = (candidate, ...arguments_) =>
    original(auditedPath(candidate, `fs.${name}`), ...arguments_);
}
for (const name of ["readFile", "open", "readlink"]) {
  const original = fs[name].bind(fs);
  fs[name] = (candidate, ...arguments_) =>
    original(auditedPath(candidate, `fs.${name}`), ...arguments_);
}
for (const name of ["readFile", "open", "readlink"]) {
  const original = fsPromises[name].bind(fsPromises);
  fsPromises[name] = (candidate, ...arguments_) =>
    original(auditedPath(candidate, `fs.promises.${name}`), ...arguments_);
}
syncBuiltinESMExports();

const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
if (
  !request ||
  typeof request !== "object" ||
  Array.isArray(request) ||
  JSON.stringify(Object.keys(request).sort()) !==
    JSON.stringify(["moduleReferences", "projectDirectory", "schemaVersion"]) ||
  request.schemaVersion !== 1 ||
  typeof request.projectDirectory !== "string" ||
  request.projectDirectory.length === 0 ||
  !Array.isArray(request.moduleReferences)
) {
  throw new Error("invalid constrained Vite audit request");
}
for (const reference of request.moduleReferences) {
  if (
    !reference ||
    typeof reference !== "object" ||
    Array.isArray(reference) ||
    JSON.stringify(Object.keys(reference).sort()) !==
      JSON.stringify(["importer", "location", "specifier"]) ||
    typeof reference.importer !== "string" ||
    !path.isAbsolute(reference.importer) ||
    !inside(projectRoot, reference.importer) ||
    typeof reference.location !== "string" ||
    reference.location.length === 0 ||
    typeof reference.specifier !== "string" ||
    reference.specifier.length === 0
  ) {
    throw new Error("invalid constrained Vite module reference");
  }
}

function projectedRealpath(candidate, label) {
  let current = path.resolve(candidate);
  const missing = [];
  while (true) {
    try {
      const resolved = fs.realpathSync(current);
      if (missing.length > 0 && !fs.statSync(resolved).isDirectory()) {
        throw new Error(`${label} traverses through a non-directory: ${current}`);
      }
      return path.resolve(resolved, ...missing.reverse());
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

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
    for (const nested of resolved) {
      plugins.push(...(await normalizedVitePlugins(nested)));
    }
    return plugins;
  }
  if (typeof resolved !== "object") {
    throw new Error("plugins must resolve to plugin objects");
  }
  return [resolved];
}

function viteInputEntries(value, label) {
  if (value === undefined || value === false) return [];
  if (typeof value === "string") return [{ label, value }];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      viteInputEntries(entry, `${label}[${index}]`),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([name, entry]) =>
      viteInputEntries(entry, `${label}.${name}`),
    );
  }
  throw new Error(`${label} must contain only filesystem path strings`);
}

function viteFilesystemViolation(
  candidate,
  label,
  { allowShared = true } = {},
) {
  const query = candidate.search(/[?#]/);
  let identifier = query < 0 ? candidate : candidate.slice(0, query);
  if (identifier.startsWith("\0")) {
    return `${label} resolves to an opaque virtual module`;
  }
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
    if (error.code === "ERR_ACCESS_DENIED") {
      return `${label} escapes wallet/${request.projectDirectory}: ${candidate}`;
    }
    return error.message;
  }
  const ownerLocal = inside(projectRoot, lexical) && inside(projectRoot, canonical);
  const namedShared = inside(sharedRoot, lexical) && inside(sharedRoot, canonical);
  return ownerLocal || (allowShared && namedShared)
    ? null
    : `${label} escapes wallet/${request.projectDirectory}: ${candidate}`;
}

function viteInputViolations(resolved) {
  const violations = [];
  const configName = path.basename(resolved.configFile);
  for (const [label, candidate] of [
    ["root", resolved.root],
    ["publicDir", resolved.publicDir === false ? undefined : resolved.publicDir],
  ]) {
    if (candidate === undefined) continue;
    const violation = viteFilesystemViolation(
      path.resolve(projectRoot, candidate),
      `${request.projectDirectory}/${configName} Vite ${label}`,
      { allowShared: false },
    );
    if (violation) violations.push(violation);
  }
  const inputs = [
    ...viteInputEntries(
      resolved.build?.rollupOptions?.input,
      "build.rollupOptions.input",
    ),
    ...viteInputEntries(resolved.build?.lib?.entry, "build.lib.entry"),
    ...viteInputEntries(
      typeof resolved.build?.ssr === "string" ? resolved.build.ssr : undefined,
      "build.ssr",
    ),
  ];
  for (const input of inputs) {
    const violation = viteFilesystemViolation(
      path.resolve(resolved.root, input.value),
      `${request.projectDirectory}/${configName} Vite ${input.label}`,
    );
    if (violation) violations.push(violation);
  }
  return violations;
}

function viteResolveHandler(plugin) {
  if (typeof plugin.resolveId === "function") return plugin.resolveId;
  if (
    plugin.resolveId &&
    typeof plugin.resolveId === "object" &&
    typeof plugin.resolveId.handler === "function"
  ) {
    return plugin.resolveId.handler;
  }
  if (plugin.resolveId === undefined) return null;
  throw new Error(
    `plugin ${plugin.name ?? "<unnamed>"} has an unauditable resolveId hook`,
  );
}

function localBareModuleCandidate(specifier) {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("\0")
  ) {
    return null;
  }
  const segments = specifier.split("/");
  const packageSegments = specifier.startsWith("@")
    ? segments.slice(0, 2)
    : segments.slice(0, 1);
  if (
    packageSegments.length === 0 ||
    packageSegments.some(
      (segment) => !segment || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  const packageRoot = path.join(
    projectRoot,
    "node_modules",
    ...packageSegments,
  );
  try {
    fs.lstatSync(packageRoot);
    return path.join(projectRoot, "node_modules", ...segments);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    if (error.code === "ERR_ACCESS_DENIED") {
      return path.join(projectRoot, "node_modules", ...segments);
    }
    throw error;
  }
}

function errorDetail(error) {
  const permission =
    typeof error?.permission === "string" && typeof error?.resource === "string"
      ? ` [${error.permission}: ${error.resource}]`
      : "";
  return `${error?.message ?? String(error)}${permission}`;
}

// Load Vite only after the read boundary is installed so every Node fs binding
// it and the user config capture is the audited binding above.
const { build, loadConfigFromFile, resolveConfig } = await import(
  pathToFileURL(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../node_modules/vite/dist/node/index.js",
    ),
  )
);
const typescriptModule = await import(
  pathToFileURL(
    path.join(boundaryNodeModules, "typescript/lib/typescript.js"),
  ),
);
const typescript = typescriptModule.default ?? typescriptModule;
const boundaryTypescriptPlugin = {
  name: "wallet-boundary-typescript-transform",
  enforce: "pre",
  transform(code, id) {
    const cleanId = id.split(/[?#]/, 1)[0];
    if (!/\.[cm]?[jt]sx?$/.test(cleanId) || cleanId.endsWith(".d.ts")) {
      return null;
    }
    const typescriptSource = /\.[cm]?tsx?$/.test(cleanId);
    const result = typescriptSource
      ? typescript.transpileModule(code, {
          fileName: cleanId,
          compilerOptions: {
            jsx: typescript.JsxEmit.ReactJSX,
            module: typescript.ModuleKind.ESNext,
            target: typescript.ScriptTarget.ESNext,
          },
          reportDiagnostics: true,
        })
      : { diagnostics: [], outputText: code };
    const errors = (result.diagnostics ?? []).filter(
      (diagnostic) =>
        diagnostic.category === typescript.DiagnosticCategory.Error,
    );
    if (errors.length > 0) {
      throw new Error(
        `TypeScript boundary transform failed for ${cleanId}: ${errors
          .map((diagnostic) =>
            typescript.flattenDiagnosticMessageText(
              diagnostic.messageText,
              " ",
            ),
          )
          .join("; ")}`,
      );
    }
    return {
      code: result.outputText
        .replaceAll("import.meta.env", "({})")
        .replaceAll("import.meta.hot", "undefined"),
      map: null,
    };
  },
};

const violations = [];
const environments = [
  { command: "build", mode: "production" },
  { command: "serve", mode: "development" },
];
for (const environment of environments) {
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
      projectRoot,
      "silent",
      undefined,
      "native",
    );
    resolved = await resolveConfig(
      {
        configFile,
        configLoader: "native",
        css: { postcss: { plugins: [] } },
        esbuild: false,
        logLevel: "silent",
        mode: environment.mode,
        root: projectRoot,
      },
      environment.command,
      environment.mode,
    );
  } catch (error) {
    violations.push(
      `${request.projectDirectory}/${path.basename(configFile)}: Vite ${environment.command} configuration is not auditable: ${errorDetail(error)}`,
    );
    continue;
  }
  try {
    violations.push(...viteInputViolations(resolved));
  } catch (error) {
    violations.push(
      `${request.projectDirectory}/${path.basename(configFile)}: Vite ${environment.command} inputs are not auditable: ${error.message}`,
    );
  }
  let aliases;
  try {
    aliases = normalizedViteAliases(loaded?.config?.resolve?.alias);
  } catch (error) {
    violations.push(
      `${request.projectDirectory}/${path.basename(configFile)}: ${error.message}`,
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
        `${request.projectDirectory}/${path.basename(configFile)}: Vite alias entries must use auditable string find/replacement pairs without custom resolvers`,
      );
      continue;
    }
    if (
      !path.isAbsolute(alias.replacement) &&
      !alias.replacement.startsWith(".")
    ) {
      violations.push(
        `${request.projectDirectory}/${path.basename(configFile)}: Vite alias ${alias.find} must use a filesystem replacement`,
      );
      continue;
    }
    const lexical = path.resolve(projectRoot, alias.replacement);
    let canonical;
    try {
      canonical = projectedRealpath(
        lexical,
        `${request.projectDirectory}/${path.basename(configFile)} Vite alias ${alias.find}`,
      );
    } catch (error) {
      violations.push(error.message);
      continue;
    }
    const sharedAlias = alias.find === "@free2z/wallet-shared";
    const boundary = sharedAlias ? sharedRoot : projectRoot;
    if (!inside(boundary, lexical) || !inside(boundary, canonical)) {
      violations.push(
        `${request.projectDirectory}/${path.basename(configFile)}: Vite alias ${alias.find} escapes wallet/${request.projectDirectory}: ${alias.replacement}`,
      );
    }
  }
  const resolver = resolved.createResolver();
  for (const reference of request.moduleReferences) {
    let standard;
    try {
      standard = await resolver(reference.specifier, reference.importer);
    } catch (error) {
      violations.push(
        `${reference.location}: Vite ${environment.command} resolution is not auditable: ${errorDetail(error)}`,
      );
      continue;
    }
    if (standard) {
      const violation = viteFilesystemViolation(
        typeof standard === "string" ? standard : standard.id,
        `${reference.location} Vite ${environment.command} resolution of ${reference.specifier}`,
      );
      if (violation) violations.push(violation);
    } else {
      const localCandidate = localBareModuleCandidate(reference.specifier);
      if (localCandidate) {
        const violation = viteFilesystemViolation(
          localCandidate,
          `${reference.location} Vite ${environment.command} resolution of ${reference.specifier}`,
        );
        if (violation) violations.push(violation);
      }
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
      `${request.projectDirectory}/${path.basename(configFile)}: Vite plugins are not auditable: ${error.message}`,
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
        throw new Error(
          `unsupported Rollup plugin context member ${String(property)}`,
        );
      },
    },
  );
  for (const plugin of plugins) {
    let handler;
    try {
      handler = viteResolveHandler(plugin);
    } catch (error) {
      violations.push(
        `${request.projectDirectory}/${path.basename(configFile)}: ${error.message}`,
      );
      continue;
    }
    if (!handler) continue;
    for (const reference of request.moduleReferences) {
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
        candidate,
        `${reference.location} Vite plugin ${plugin.name ?? "<unnamed>"} resolution of ${reference.specifier}`,
      );
      if (violation) violations.push(violation);
    }
  }
}

let buildVerified = false;
if (operation === "build") {
  try {
    await build({
  root: path.resolve(projectRoot),
  configFile: path.resolve(configFile),
  configLoader: "native",
  css: { postcss: { plugins: [] } },
  esbuild: false,
  logLevel: "silent",
  mode: "production",
  server: { fs: { allow: allowedRoots } },
  worker: { plugins: () => [boundaryTypescriptPlugin] },
  plugins: [
    boundaryTypescriptPlugin,
    {
      name: "wallet-boundary-no-child-toolchain",
      enforce: "post",
      config(config) {
        config.define = {};
        return {
          css: { postcss: { plugins: [] } },
          esbuild: false,
          environments: { client: { define: {}, keepProcessEnv: true } },
          keepProcessEnv: true,
          build: { minify: false },
          server: { fs: { allow: allowedRoots } },
        };
      },
    },
    {
      name: "wallet-boundary-generated-wasm-placeholder",
      enforce: "pre",
      resolveId(specifier, importer) {
        return specifier ===
          "../../wasm-spike/generated/zuu_wasm_spike.wasm?init&no-inline" &&
          importer?.endsWith(
            `${path.sep}src${path.sep}lib${path.sep}wasm-spike.ts`,
          )
          ? "\0wallet-boundary-generated-wasm-placeholder"
          : null;
      },
      load(id) {
        return id === "\0wallet-boundary-generated-wasm-placeholder"
          ? "export default async function generatedWasmPlaceholder() { return { exports: {} }; }"
          : null;
      },
    },
  ],
  build: {
    outDir: path.resolve(outputDirectory),
    emptyOutDir: true,
    minify: false,
  },
    });
    buildVerified = true;
  } catch (error) {
    violations.push(
      `${request.projectDirectory}/${path.basename(configFile)}: constrained production Vite graph build failed; a plugin or module may have read outside wallet/${request.projectDirectory} and wallet/shared: ${error.stack ?? error.message}`,
    );
  }
}

fs.writeFileSync(
  resultFile,
  JSON.stringify({
    buildVerified,
    configFile,
    environments: environments.map(
      ({ command, mode }) => `${command}:${mode}`,
    ),
    projectRoot,
    schemaVersion: 1,
    violations: [...new Set(violations)],
  }),
  { flag: "wx" },
);
