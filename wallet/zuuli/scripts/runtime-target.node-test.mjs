import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  PRODUCTION_TARGET_MARKER,
  verifyProductionRuntimeTarget,
} from "./runtime-target.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

async function fixture(contents) {
  const root = await mkdtemp(resolve(tmpdir(), "zuuli-runtime-target-"));
  const assets = resolve(root, "assets");
  await mkdir(assets);
  await Promise.all(
    contents.map((source, index) =>
      writeFile(resolve(assets, `${index}.js`), source, "utf8"),
    ),
  );
  return root;
}

function boundRuntime(marker = PRODUCTION_TARGET_MARKER, suffix = "") {
  return `const target${suffix}=${JSON.stringify(marker)};function parse${suffix}(value){const [,api,media]=value.split('|');return {api:api.slice(4),media:media.slice(6)}}function production${suffix}(){return parse${suffix}(target${suffix})}const origins${suffix}=production${suffix}(),api${suffix}=origins${suffix}.api,media${suffix}=origins${suffix}.media;`;
}

test("accepts one production marker in the compiled JavaScript inventory", async (t) => {
  const root = await fixture([boundRuntime()]);
  t.after(() => rm(root, { recursive: true }));
  await verifyProductionRuntimeTarget(root);
});

test("rejects a marker parked in a comment or unrelated string", async (t) => {
  const root = await fixture([
    `// ${PRODUCTION_TARGET_MARKER}\nconst note=${JSON.stringify(PRODUCTION_TARGET_MARKER)};`,
  ]);
  t.after(() => rm(root, { recursive: true }));
  await assert.rejects(
    verifyProductionRuntimeTarget(root),
    /expected exactly one canonical runtime binding/,
  );
});

test(
  "rejects a linked production decoy beside the actual staging runtime",
  async (t) => {
    const root = await fixture([
      `${boundRuntime()}const API_BASE="https://stage.free2z.cash";fetch(API_BASE+"/api/zpage/");`,
    ]);
    t.after(() => rm(root, { recursive: true }));
    await assert.rejects(
      verifyProductionRuntimeTarget(root),
      /compiled artifact retained forbidden staging authority/,
    );
  },
);

test("rejects inherited Vite API, media, and proxy variables", async (t) => {
  for (const key of ["VITE_F2Z_API", "VITE_F2Z_MEDIA", "VITE_F2Z_PROXY"]) {
    const root = await fixture([
      `${boundRuntime()}const env={${key}:"present"};`,
    ]);
    t.after(() => rm(root, { recursive: true }));
    await assert.rejects(
      verifyProductionRuntimeTarget(root),
      new RegExp(`forbidden staging authority: ${key}`),
    );
  }
});

test("the production build cannot skip artifact target verification", async () => {
  const packageDocument = JSON.parse(
    await readFile(resolve(projectRoot, "package.json"), "utf8"),
  );
  assert.equal(
    packageDocument.scripts["runtime-target:verify"],
    "node scripts/runtime-target.mjs --dist=dist",
  );
  assert.match(
    packageDocument.scripts.build,
    /&& npm run runtime-target:verify$/,
  );
});

for (const [name, sources, expected] of [
  [
    "missing provenance",
    ["const target='';"],
    /expected exactly one canonical runtime binding/,
  ],
  [
    "explicit staging API",
    [
      boundRuntime(
        PRODUCTION_TARGET_MARKER.replace(
          "api=https://free2z.cash",
          "api=https://stage.free2z.cash",
        ),
      ),
    ],
    /compiled artifact retained forbidden staging authority/,
  ],
  [
    "explicit staging media",
    [
      boundRuntime(
        PRODUCTION_TARGET_MARKER.replace(
          "media=https://free2z.cash",
          "media=https://stage.free2z.cash",
        ),
      ),
    ],
    /compiled artifact retained forbidden staging authority/,
  ],
  [
    "ambiguous duplicate provenance",
    [
      boundRuntime(PRODUCTION_TARGET_MARKER, "A"),
      boundRuntime(PRODUCTION_TARGET_MARKER, "B"),
    ],
    /expected exactly one canonical runtime binding/,
  ],
]) {
  test(`rejects ${name}`, async (t) => {
    const root = await fixture(sources);
    t.after(() => rm(root, { recursive: true }));
    await assert.rejects(verifyProductionRuntimeTarget(root), expected);
  });
}
