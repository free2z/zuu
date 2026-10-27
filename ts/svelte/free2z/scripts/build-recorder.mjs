import { build } from "esbuild";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  cp,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** @param {string} expected @param {string} actual */
async function assertSameTree(expected, actual) {
  const names = (await readdir(expected)).sort();
  const present = (await readdir(actual)).sort();
  if (JSON.stringify(names) !== JSON.stringify(present)) {
    throw new Error(
      "Existing recorder generation is incomplete or contains unexpected files",
    );
  }
  for (const entry of await readdir(expected, { withFileTypes: true })) {
    const source = join(expected, entry.name);
    const destination = join(actual, entry.name);
    if (entry.isDirectory()) {
      await assertSameTree(source, destination);
    } else if (!(await readFile(source)).equals(await readFile(destination))) {
      throw new Error("Existing recorder generation has different bytes");
    }
  }
}

/** @param {string} path @param {string | Buffer} data @param {string} stagingRoot */
async function writeAtomic(path, data, stagingRoot) {
  const temporary = await mkdtemp(join(stagingRoot, ".recorder-html-"));
  try {
    const staged = join(temporary, "content");
    await writeFile(staged, data);
    await rename(staged, path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function buildRecorder(destination = "build/client") {
  const output = resolve(root, destination);
  const source = join(root, "src/recorder");
  const ui = join(
    root,
    "node_modules/@cloudflare/realtimekit-ui/dist/realtimekit-ui",
  );
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(source, "app.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    minify: true,
    write: false,
    tsconfigRaw: {},
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const script = result.outputFiles[0].text;
  const css = await readFile(join(source, "style.css"));
  const hash = createHash("sha256").update(script).update(css);
  for (const name of (await readdir(ui)).sort())
    hash.update(name).update(await readFile(join(ui, name)));
  const id = hash.digest("hex").slice(0, 24);
  // Immutable recorder assets must remain available across rollouts:
  // HTML and JavaScript can be served by different application versions.
  const prefix = `/_app/immutable/recorder/${id}/`;
  const assets = join(output, prefix.slice(1));
  await mkdir(dirname(assets), { recursive: true });
  // Keep ephemeral directories outside the served tree: Vite inventories it
  // concurrently. A sibling directory preserves same-filesystem atomic rename.
  const stagingRoot = dirname(output);
  const staged = await mkdtemp(join(stagingRoot, ".recorder-build-"));
  try {
    await cp(ui, join(staged, "ui"), { recursive: true });
    await writeFile(
      join(staged, "app.js"),
      script.replaceAll("__FREE2Z_RECORDER_ASSET_BASE__", prefix),
    );
    await writeFile(join(staged, "style.css"), css);
    // mkdtemp is owner-only; published assets must be readable by the server user.
    await chmod(staged, 0o755);
    try {
      // A reader sees either no generation or the complete immutable directory.
      await rename(staged, assets);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (!["EEXIST", "ENOTEMPTY"].includes(code)) throw error;
      // Another process may have published this generation. Verify all bytes,
      // including existing outputs from older builders, before reusing it.
      await assertSameTree(staged, assets);
      await chmod(assets, 0o755);
    }
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
  await mkdir(join(output, "tools/recording"), { recursive: true });
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>Meeting recorder</title><link rel="stylesheet" href="${prefix}style.css"></head>
<body><div id="meeting"></div><p id="status">Joining recording…</p><script type="module" src="${prefix}app.js"></script></body></html>\n`;
  const htmlPath = join(output, "tools/recording/index.html");
  // Each representation is replaced atomically and references a fully
  // published immutable generation, including during concurrent dev builds.
  await Promise.all([
    writeAtomic(htmlPath, html, stagingRoot),
    writeAtomic(`${htmlPath}.gz`, gzipSync(html), stagingRoot),
    writeAtomic(`${htmlPath}.br`, brotliCompressSync(html), stagingRoot),
  ]);
  console.log("Built standalone meeting recorder");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await buildRecorder(process.argv[2]);
}
