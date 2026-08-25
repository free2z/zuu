import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [projectRoot, configFile, outputDirectory, allowedRootsJson] =
  process.argv.slice(2);
if (path.resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) {
  throw new Error(
    "the constrained Vite build helper must run as its entry point",
  );
}
if (!projectRoot || !configFile || !outputDirectory || !allowedRootsJson) {
  throw new Error(
    "expected project root, Vite config, output directory, and allowed read roots",
  );
}

const allowedRoots = JSON.parse(allowedRootsJson).map((root) =>
  fs.realpathSync(root),
);
allowedRoots.push(fs.realpathSync(outputDirectory));

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
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

// Load Vite only after the read boundary is installed so every Node fs binding
// it and the user config capture is the audited binding above.
const { build } = await import(
  pathToFileURL(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../node_modules/vite/dist/node/index.js",
    ),
  )
);

await build({
  root: path.resolve(projectRoot),
  configFile: path.resolve(configFile),
  logLevel: "silent",
  mode: "production",
  plugins: [
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
  },
});
