import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { build as viteBuild, resolveConfig as viteResolveConfig } from "vite";
import {
  assertProjectBoundaries,
  main as runProductionBoundary,
} from "./project-boundary.mjs";

// The constrained Vite build helper's own wrapping message (see
// `errorDetail`/the catch block around `build()` in
// project-boundary-vite-build.mjs) is the one part of a boundary-build
// failure this suite controls end to end. Everything appended after it is
// whatever Node's `--permission` model (or Vite/Rollup) happened to say about
// *why* a read was denied, and that nested wording is not stable across Node
// versions: Node 24.18 changed several of these messages (e.g. dropping the
// literal "FileSystemWrite"/"allow-fs-write" tokens, and in some cases
// tripping the OS-level permission check on an earlier, unrelated read before
// the deliberately-injected cross-app read is ever reached) without changing
// whether the build was actually blocked. Assert on this stable prefix
// instead of on Node's permission-model wording so the tests track the
// behavioural guarantee (the production build never completes when a plugin
// or module reads outside the owner/shared graph) rather than a message that
// can drift with the Node version.
const ZUULI_CONSTRAINED_BUILD_FAILURE =
  /zuuli\/vite\.config\.ts: constrained production Vite graph build failed; a plugin or module may have read outside wallet\/zuuli and wallet\/shared:/;

const SHARED_DEPENDENCY = { "@free2z/wallet-shared": "file:../shared" };
const REQUIRED_PRODUCTION_CONSUMERS = [
  "zuuallet/src/lib/sensitive-entry.ts",
  "zuuallet/src/lib/tauri.ts",
  "zuuli/src/lib/wallet/bridge.ts",
  "zuuli/src/lib/wallet/mock.ts",
  "zuuli/src/lib/wallet/sensitive-entry.ts",
];
const SENSITIVE_ENTRY_CONSUMER = [
  "import { SensitiveEntrySession, bindSensitiveEntryLifecycle, type SensitiveEntryPurpose } from \"@free2z/wallet-shared\";",
  "const authority = {",
  "  begin: (purpose: SensitiveEntryPurpose) => purpose,",
  "  end: (token: string, purpose: SensitiveEntryPurpose) => [token, purpose],",
  "};",
  "declare function useRef<T>(value: T): { current: T };",
  "function useSensitiveMnemonicEntry(purpose: SensitiveEntryPurpose) {",
  "  const session = useRef<SensitiveEntrySession | null>(null);",
  "  session.current = new SensitiveEntrySession(authority, purpose, ...([] as never));",
  "  return bindSensitiveEntryLifecycle({} as never, () => session.current?.release());",
  "}",
].join("\n");
// A stand-in for wallet/shared/src/intent, small enough to read and complete
// enough to satisfy the single-implementation anchor.
const INTENT_BRIDGE_STUB = [
  "export const INTENT_PROTOCOL_VERSION = 1;",
  "export function encodeIntentRequest(request: unknown) { return request; }",
  "export function decodeIntentResponse(bytes: unknown) { return bytes; }",
  "export function createIntentSession() { return {}; }",
  "export function parseVisibleText(bytes: unknown) { return String(bytes); }",
].join("\n");
const REQUIRED_PRODUCTION_SOURCES = new Map([
  ["zuuallet/src/lib/sensitive-entry.ts", SENSITIVE_ENTRY_CONSUMER],
  [
    "zuuallet/src/lib/tauri.ts",
    'import type { SensitiveEntryPurpose } from "@free2z/wallet-shared";\nexport function beginSensitiveEntry(purpose: SensitiveEntryPurpose) { return purpose; }\nexport function endSensitiveDisplay(purpose: SensitiveEntryPurpose) { return purpose; }\n',
  ],
  [
    "zuuli/src/lib/wallet/bridge.ts",
    'import type { SensitiveEntryPurpose } from "@free2z/wallet-shared";\nexport const wallet = { beginSensitiveEntry(purpose: SensitiveEntryPurpose) { return purpose; }, endSensitiveDisplay(purpose: SensitiveEntryPurpose) { return purpose; } };\n',
  ],
  [
    "zuuli/src/lib/wallet/mock.ts",
    'import type { SensitiveEntryPurpose } from "@free2z/wallet-shared";\nlet sensitiveDisplayPurpose: SensitiveEntryPurpose | null = null;\nexport const mockWallet = { beginSensitiveDisplay(purpose: SensitiveEntryPurpose) { sensitiveDisplayPurpose = purpose; }, endSensitiveDisplay(purpose: SensitiveEntryPurpose) { sensitiveDisplayPurpose = purpose; } };\n',
  ],
  ["zuuli/src/lib/wallet/sensitive-entry.ts", SENSITIVE_ENTRY_CONSUMER],
]);

async function fixture(files = {}, dependencyOverrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wallet-project-boundary-"));
  await mkdir(path.join(root, "shared/src"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ private: true, workspaces: ["shared"] }),
  );
  await writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      packages: {
        "node_modules/@free2z/wallet-shared": { resolved: "shared", link: true },
      },
    }),
  );
  await writeFile(
    path.join(root, "shared/package.json"),
    JSON.stringify({
      name: "@free2z/wallet-shared",
      private: true,
      type: "module",
      exports: { ".": "./src/index.ts" },
    }),
  );
  // The single intent-bridge implementation (#905). Every fixture carries a
  // minimal one because the scanner requires the module to exist, to be
  // re-exported through the package's one entry point, and to declare every
  // guard name — the coverage half of the rule, without which the exclusivity
  // half would protect nothing.
  await mkdir(path.join(root, "shared/src/intent"), { recursive: true });
  await writeFile(
    path.join(root, "shared/src/intent/index.ts"),
    INTENT_BRIDGE_STUB,
  );
  await writeFile(
    path.join(root, "shared/src/index.ts"),
    'export * from "./intent";\n',
  );
  for (const project of ["zuuli", "zuuallet"]) {
    await mkdir(path.join(root, project, "src/nested/deeper"), { recursive: true });
    const dependencies = dependencyOverrides[project] ?? SHARED_DEPENDENCY;
    await writeFile(
      path.join(root, project, "package.json"),
      JSON.stringify({
        name: project,
        private: true,
        dependencies,
        devDependencies: { vite: "*" },
      }),
    );
    await writeFile(
      path.join(root, project, "vite.config.ts"),
      "export default {};\n",
    );
    await writeFile(path.join(root, project, "src/local.ts"), "export const local = true;\n");
    await writeFile(
      path.join(root, project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions:
          project === "zuuli"
            ? { baseUrl: ".", paths: { "@/*": ["./src/*"] } }
            : {},
        include: ["src"],
      }),
    );
  }
  for (const relative of REQUIRED_PRODUCTION_CONSUMERS) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, REQUIRED_PRODUCTION_SOURCES.get(relative));
  }
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return realpath(root);
}

async function withFixture(files, assertion, dependencies) {
  const root = await fixture(files, dependencies);
  try {
    await assertion(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function addMinimalViteEntries(root) {
  for (const project of ["zuuli", "zuuallet"]) {
    await writeFile(
      path.join(root, project, "index.html"),
      '<script type="module" src="/src/main.ts"></script>\n',
    );
    await writeFile(
      path.join(root, project, "src/main.ts"),
      "console.log('owner');\n",
    );
  }
}

test("current wallet source graph has no undeclared project crossing", async () => {
  const walletRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const result = await assertProjectBoundaries(walletRoot, {
    verifyViteBuildGraph: true,
  });
  assert.ok(result.fileCount > 100, "live census must traverse both application source trees");
  assert.ok(result.importCount > 300, "live census must parse the production module graph");
  assert.deepEqual(
    result.projectDirectories,
    ["e2e2z", "free2z", "shared", "zuuallet", "zuuli"],
    "live project population must match every manifest-backed wallet source tree",
  );
  assert.equal(
    result.productionSharedConsumerCount,
    5,
    "all five production shared consumers must use the named package",
  );
  // Three, not four, and the gap is deliberate rather than an oversight.
  //
  // The constrained Vite audit only runs for a project that ships a
  // `vite.config.*`, and it runs a real production Rollup build inside a Node
  // permission sandbox whose read authority is `wallet/<project>`,
  // `wallet/shared` and `wallet/zuuli/node_modules`. That build therefore needs
  // the project's OWN `node_modules` present — which is why the required
  // `frontend` job in `.github/workflows/zuuli.yml` installs zuuli's,
  // zuuallet's AND free2z's before running this check. That job's step list is
  // byte-pinned by `scripts/check-github-actions-pins.mjs`
  // (`REQUIRED_FRONTEND_JOB_LINES`), so each of those installs had to be added
  // there first.
  //
  // #906 scaffolded both delegated surfaces with no Vite config at all, for
  // exactly that reason. The content extraction (#904 phase 1) ended that for
  // `wallet/free2z`: its Markdown pipeline cannot build on Vite's defaults —
  // the Mermaid worker dynamically imports `mermaid`, which Rollup refuses to
  // code-split under the default `worker.format: "iife"`, and rehype-mathjax
  // needs a `PACKAGE_VERSION` define. So free2z now ships a real config and is
  // audited like the other two.
  //
  // `wallet/e2e2z` is still a placeholder screen and still ships none, so its
  // config/plugin escape audit has no subject — nothing about the boundary
  // itself is skipped for it: every source file is still parsed and every
  // module specifier is still held to the cross-application rule above. When
  // that app grows a Vite config this number moves to four and its `npm ci`
  // has to reach the required job first.
  assert.equal(
    result.viteBuildsVerified,
    3,
    "every wallet application that ships a Vite config must complete the constrained production Vite graph build",
  );
  assert.equal(
    result.sharedIntentGuardCount,
    5,
    "every intent-bridge guard must be declared in the one shared implementation",
  );
});

test("accepts local, aliased, external, and named shared imports", async () => {
  await withFixture(
    {
      "zuuli/src/nested/deeper/consumer.ts": [
        'import "../../local";',
        'import local from "@/local";',
        'import React from "react";',
        'import { shared } from "@free2z/wallet-shared";',
        "void local; void React; void shared;",
      ].join("\n"),
      "zuuallet/src/nested/consumer.ts": [
        'const shared = import("@free2z/wallet-shared");',
        'const local = require("../local");',
        "void shared; void local;",
      ].join("\n"),
    },
    async (root) => {
      const result = await assertProjectBoundaries(root);
      assert.equal(result.violations.length, 0);
    },
  );
});

for (const [label, source, expected] of [
  [
    "one-level static app import",
    'import secret from "../../../../zuuallet/src/local";',
    "relative import escapes wallet/zuuli",
  ],
  [
    "deep static app import",
    'import secret from "../../../../../zuuallet/src/local";',
    "relative import escapes wallet/zuuli",
  ],
  [
    "re-exported app source",
    'export * from "../../../../../zuuallet/src/local";',
    "relative import escapes wallet/zuuli",
  ],
  [
    "dynamic app import",
    'const secret = import("../../../../../zuuallet/src/local");',
    "relative import escapes wallet/zuuli",
  ],
  [
    "CommonJS app import",
    'const secret = require("../../../../../zuuallet/src/local");',
    "relative import escapes wallet/zuuli",
  ],
  [
    "CommonJS require.resolve app import",
    'const secret = require.resolve("../../../../../zuuallet/src/local");',
    "relative import escapes wallet/zuuli",
  ],
  [
    "TypeScript import-equals app import",
    'import secret = require("../../../../../zuuallet/src/local");',
    "relative import escapes wallet/zuuli",
  ],
  [
    "relative shared import",
    'import shared from "../../../../shared/session";',
    "relative import escapes wallet/zuuli",
  ],
  [
    "absolute source import",
    'import secret from "/tmp/zuuallet/src/local";',
    "absolute source import is forbidden",
  ],
  [
    "file URL source import",
    'import secret from "file:///tmp/zuuallet/src/local.ts";',
    "absolute source import is forbidden",
  ],
  [
    "bare app package import",
    'import secret from "zuuallet/src/local";',
    "imports the zuuallet application as a package",
  ],
]) {
  test(`rejects ${label}`, async () => {
    await withFixture(
      { "zuuli/src/nested/deeper/boundary.ts": source },
      async (root) => {
        await assert.rejects(() => assertProjectBoundaries(root), new RegExp(expected));
      },
    );
  });
}

test("rejects a non-literal dynamic import instead of silently skipping it", async () => {
  await withFixture(
    { "zuuli/src/dynamic.ts": "const target = './local'; void import(target);\n" },
    async (root) => {
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /dynamic import must use a statically auditable module specifier/,
      );
    },
  );
});

test("keeps the shared package from depending back on either application", async () => {
  await withFixture(
    { "shared/src/app-leak.ts": 'import "../../zuuli/src/local";\n' },
    async (root) => {
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /relative import escapes wallet\/shared/,
      );
    },
  );
});

test("discovers a future manifest-backed wallet source project", async () => {
  await withFixture({}, async (root) => {
    await mkdir(path.join(root, "future-wallet/src"), { recursive: true });
    await writeFile(
      path.join(root, "future-wallet/package.json"),
      JSON.stringify({ name: "future-wallet", private: true }),
    );
    await writeFile(
      path.join(root, "future-wallet/src/local.ts"),
      "export const future = true;\n",
    );
    const result = await assertProjectBoundaries(root);
    assert.deepEqual(result.projectDirectories, [
      "future-wallet",
      "shared",
      "zuuallet",
      "zuuli",
    ]);
  });
});

test("rejects a crossing from a future manifest-backed wallet project", async () => {
  await withFixture({}, async (root) => {
    await mkdir(path.join(root, "future-wallet/src"), { recursive: true });
    await writeFile(
      path.join(root, "future-wallet/package.json"),
      JSON.stringify({ name: "future-wallet", private: true }),
    );
    await writeFile(
      path.join(root, "future-wallet/src/leak.ts"),
      'import "../../zuuallet/src/local";\n',
    );
    await assert.rejects(
      () => assertProjectBoundaries(root),
      /relative import escapes wallet\/future-wallet/,
    );
  });
});

test("rejects an inherited TypeScript path alias that escapes its owner", async () => {
  await withFixture(
    { "zuuli/src/aliased.ts": 'import "@classic/local";\n' },
    async (root) => {
      await writeFile(
        path.join(root, "zuuli/tsconfig.base.json"),
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "@classic/*": ["../zuuallet/src/*"] },
          },
        }),
      );
      await writeFile(
        path.join(root, "zuuli/tsconfig.json"),
        JSON.stringify({ extends: "./tsconfig.base.json", include: ["src"] }),
      );
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /TypeScript path alias @classic\/\* escapes wallet\/zuuli/,
      );
    },
  );
});

test("rejects an unused effective TypeScript path alias that escapes its owner", async () => {
  await withFixture({}, async (root) => {
    await writeFile(
      path.join(root, "zuuli/tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@classic/*": ["../zuuallet/src/*"] },
        },
      }),
    );
    await writeFile(
      path.join(root, "zuuli/tsconfig.json"),
      JSON.stringify({ extends: "./tsconfig.base.json", include: ["src"] }),
    );
    await assert.rejects(
      () => assertProjectBoundaries(root),
      /TypeScript path alias @classic\/\* escapes wallet\/zuuli/,
    );
  });
});

test("rejects an effective TypeScript baseUrl that escapes its owner", async () => {
  await withFixture({}, async (root) => {
    await writeFile(
      path.join(root, "zuuli/tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: "../zuuallet" }, include: ["src"] }),
    );
    await assert.rejects(
      () => assertProjectBoundaries(root),
      /TypeScript baseUrl escapes wallet\/zuuli/,
    );
  });
});

test("rejects effective rootDirs after TypeScript proves a relative app crossing", async () => {
  await withFixture(
    {
      "zuuli/src/root-dirs-leak.ts": 'import "./classic-only";\n',
      "zuuallet/src/classic-only.ts": "export const classicOnly = true;\n",
    },
    async (root) => {
      const configFile = path.join(root, "zuuli/tsconfig.json");
      await writeFile(
        configFile,
        JSON.stringify({
          compilerOptions: {
            rootDirs: ["src", "../zuuallet/src"],
          },
          include: ["src"],
        }),
      );
      const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, ts.sys);
      assert.ok(parsed, "TypeScript must parse the rootDirs fixture");
      const resolved = ts.resolveModuleName(
        "./classic-only",
        path.join(root, "zuuli/src/root-dirs-leak.ts"),
        parsed.options,
        ts.sys,
      ).resolvedModule;
      assert.equal(
        path.resolve(resolved?.resolvedFileName ?? ""),
        path.join(root, "zuuallet/src/classic-only.ts"),
        "the compiler must prove that rootDirs resolves into the sibling app",
      );
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /TypeScript rootDirs entry escapes wallet\/zuuli/,
      );
    },
  );
});

test("accepts effective rootDirs that stay canonically inside their owner", async () => {
  await withFixture({}, async (root) => {
    await mkdir(path.join(root, "zuuli/generated"), { recursive: true });
    await writeFile(
      path.join(root, "zuuli/tsconfig.json"),
      JSON.stringify({
        compilerOptions: { rootDirs: ["src", "generated"] },
        include: ["src"],
      }),
    );
    await assert.doesNotReject(() => assertProjectBoundaries(root));
  });
});

test("rejects an inherited include root from an invoked build tsconfig", async () => {
  await withFixture(
    { "zuuallet/src/included-by-build.ts": "export const crossed = true;\n" },
    async (root) => {
      const configFile = path.join(root, "zuuli/tsconfig.build.json");
      await writeFile(
        configFile,
        JSON.stringify({
          extends: "./tsconfig.json",
          include: ["src", "../zuuallet/src/included-by-build.ts"],
        }),
      );
      const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, ts.sys);
      assert.ok(parsed, "TypeScript must parse the build include fixture");
      assert.ok(
        parsed.fileNames.includes(path.join(root, "zuuallet/src/included-by-build.ts")),
        "the compiler must prove the build include compiles sibling-app source",
      );
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /zuuli\/tsconfig\.build\.json: TypeScript root file escapes wallet\/zuuli/,
      );
    },
  );
});

test("rejects an explicit files root from a sibling application", async () => {
  await withFixture(
    { "zuuallet/src/compiled-by-files.ts": "export const crossed = true;\n" },
    async (root) => {
      const configFile = path.join(root, "zuuli/tsconfig.json");
      await writeFile(
        configFile,
        JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
          files: [
            "src/local.ts",
            "src/lib/wallet/bridge.ts",
            "src/lib/wallet/mock.ts",
            "src/lib/wallet/sensitive-entry.ts",
            "../zuuallet/src/compiled-by-files.ts",
          ],
        }),
      );
      const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, ts.sys);
      assert.ok(parsed, "TypeScript must parse the files fixture");
      assert.ok(
        parsed.fileNames.includes(path.join(root, "zuuallet/src/compiled-by-files.ts")),
        "the compiler must prove files compiles sibling-app source",
      );
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /zuuli\/tsconfig\.json: TypeScript root file escapes wallet\/zuuli/,
      );
    },
  );
});

test("accepts compiler roots inside the owner and exact shared package", async () => {
  await withFixture({}, async (root) => {
    await writeFile(
      path.join(root, "zuuli/tsconfig.build.json"),
      JSON.stringify({ files: ["src/local.ts", "../shared/src/index.ts"] }),
    );
    await assert.doesNotReject(() => assertProjectBoundaries(root));
  });
});

test("rejects a Vite alias only after a real build proves the app crossing", async () => {
  await withFixture(
    {
      "zuuli/src/vite-leak.ts":
        'import { classicOnly } from "classic/classic-only"; console.log(classicOnly);\n',
      "zuuallet/src/classic-only.ts": "export const classicOnly = true;\n",
    },
    async (root) => {
      const zuuliRoot = path.join(root, "zuuli");
      await writeFile(
        path.join(zuuliRoot, "index.html"),
        '<script type="module" src="/src/vite-leak.ts"></script>\n',
      );
      await writeFile(
        path.join(zuuliRoot, "vite.config.ts"),
        `export default { resolve: { alias: { classic: ${JSON.stringify(path.join(root, "zuuallet/src"))} } } };\n`,
      );
      await assert.doesNotReject(
        () =>
          viteBuild({
            root: zuuliRoot,
            configFile: path.join(zuuliRoot, "vite.config.ts"),
            logLevel: "silent",
            build: { write: false },
          }),
        "Vite must prove that its alias can bundle sibling-app production code",
      );
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /Vite alias classic escapes wallet\/zuuli/,
      );
    },
  );
});

test("accepts Vite aliases that stay in the owner or use the exact shared name", async () => {
  await withFixture({}, async (root) => {
    await writeFile(
      path.join(root, "zuuli/vite.config.ts"),
      `export default { resolve: { alias: {
        "@": ${JSON.stringify(path.join(root, "zuuli/src"))},
        "@free2z/wallet-shared": ${JSON.stringify(path.join(root, "shared/src/index.ts"))}
      } } };\n`,
    );
    await assert.doesNotReject(() => assertProjectBoundaries(root));
  });
});

test("rejects a custom Vite resolver only after a real build proves the crossing", async () => {
  await withFixture(
    {
      "zuuli/src/plugin-leak.ts":
        'import { classicOnly } from "classic-plugin"; console.log(classicOnly);\n',
      "zuuallet/src/classic-plugin.ts": "export const classicOnly = true;\n",
    },
    async (root) => {
      const zuuliRoot = path.join(root, "zuuli");
      const sibling = path.join(root, "zuuallet/src/classic-plugin.ts");
      await writeFile(
        path.join(zuuliRoot, "index.html"),
        '<script type="module" src="/src/plugin-leak.ts"></script>\n',
      );
      await writeFile(
        path.join(zuuliRoot, "vite.config.ts"),
        `export default { plugins: [{ name: "cross-app-resolver", resolveId(id) { return id === "classic-plugin" ? ${JSON.stringify(sibling)} : null; } }] };\n`,
      );
      await assert.doesNotReject(
        () => viteBuild({
          root: zuuliRoot,
          configFile: path.join(zuuliRoot, "vite.config.ts"),
          logLevel: "silent",
          build: { write: false },
        }),
        "Vite must prove the custom resolver bundles sibling-app production code",
      );
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /Vite plugin cross-app-resolver resolution of classic-plugin escapes wallet\/zuuli/,
      );
    },
  );
});

test("rejects a custom Rollup resolver in effective Vite build options", async () => {
  await withFixture(
    {
      "zuuli/src/rollup-plugin-leak.ts":
        'import { classicOnly } from "classic-rollup-plugin"; console.log(classicOnly);\n',
      "zuuallet/src/classic-rollup-plugin.ts": "export const classicOnly = true;\n",
    },
    async (root) => {
      const zuuliRoot = path.join(root, "zuuli");
      const sibling = path.join(root, "zuuallet/src/classic-rollup-plugin.ts");
      await writeFile(
        path.join(zuuliRoot, "index.html"),
        '<script type="module" src="/src/rollup-plugin-leak.ts"></script>\n',
      );
      await writeFile(
        path.join(zuuliRoot, "vite.config.ts"),
        `export default { build: { rollupOptions: { plugins: [{ name: "cross-app-rollup-resolver", resolveId(id) { return id === "classic-rollup-plugin" ? ${JSON.stringify(sibling)} : null; } }] } } };\n`,
      );
      await assert.doesNotReject(
        () => viteBuild({ root: zuuliRoot, configFile: path.join(zuuliRoot, "vite.config.ts"), logLevel: "silent", build: { write: false } }),
        "Vite must prove a Rollup resolver bundles sibling-app production code",
      );
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /Vite plugin cross-app-rollup-resolver resolution of classic-rollup-plugin escapes wallet\/zuuli/,
      );
    },
  );
});

test("rejects a Rollup input only after a real Vite build proves the crossing", async () => {
  await withFixture(
    { "zuuallet/src/rollup-entry.ts": "export const siblingEntry = true;\n" },
    async (root) => {
      const zuuliRoot = path.join(root, "zuuli");
      const sibling = path.join(root, "zuuallet/src/rollup-entry.ts");
      await writeFile(
        path.join(zuuliRoot, "vite.config.ts"),
        `export default { build: { rollupOptions: { input: ${JSON.stringify(sibling)} } } };\n`,
      );
      await assert.doesNotReject(
        () => viteBuild({
          root: zuuliRoot,
          configFile: path.join(zuuliRoot, "vite.config.ts"),
          logLevel: "silent",
          build: { write: false },
        }),
        "Vite must prove Rollup can bundle a sibling-app production entry",
      );
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /Vite build\.rollupOptions\.input escapes wallet\/zuuli/,
      );
    },
  );
});

test("rejects a Vite-resolved bare module symlink after a real build proves the crossing", async () => {
  await withFixture(
    {
      "zuuli/src/resolved-leak.ts":
        'import { classicOnly } from "classic-link/src/classic-linked"; console.log(classicOnly);\n',
      "zuuallet/src/classic-linked.ts": "export const classicOnly = true;\n",
    },
    async (root) => {
      const zuuliRoot = path.join(root, "zuuli");
      await mkdir(path.join(zuuliRoot, "node_modules"), { recursive: true });
      await symlink(path.join(root, "zuuallet"), path.join(zuuliRoot, "node_modules/classic-link"));
      await writeFile(
        path.join(zuuliRoot, "index.html"),
        '<script type="module" src="/src/resolved-leak.ts"></script>\n',
      );
      await assert.doesNotReject(
        () => viteBuild({
          root: zuuliRoot,
          configFile: path.join(zuuliRoot, "vite.config.ts"),
          logLevel: "silent",
          build: { write: false },
        }),
        "Vite must prove a bare module symlink bundles sibling-app production code",
      );
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /Vite build resolution of classic-link\/src\/classic-linked escapes wallet\/zuuli/,
      );
    },
  );
});

test("accepts Vite build inputs inside the owner and exact shared package", async () => {
  await withFixture({}, async (root) => {
    await writeFile(
      path.join(root, "zuuli/vite.config.ts"),
      `export default { build: { rollupOptions: { input: {
        owner: ${JSON.stringify(path.join(root, "zuuli/src/local.ts"))},
        shared: ${JSON.stringify(path.join(root, "shared/src/index.ts"))}
      } } } };\n`,
    );
    await assert.doesNotReject(() => assertProjectBoundaries(root));
  });
});

test("rejects an unrestricted Vite plugin write into owner source while preserving temp output writes", async () => {
  await withFixture({}, async (root) => {
    await addMinimalViteEntries(root);
    const zuuliRoot = path.join(root, "zuuli");
    const marker = path.join(zuuliRoot, "src/.owner-write-marker");
    await writeFile(
      path.join(zuuliRoot, "vite.config.ts"),
      `import { writeFileSync } from "node:fs";
export default { plugins: [{
  name: "owner-source-writer",
  buildStart() {
    writeFileSync(${JSON.stringify(marker)}, "OWNER_SOURCE_WRITE_MARKER\\n");
  },
}] };
`,
    );
    await viteBuild({
      root: zuuliRoot,
      configFile: path.join(zuuliRoot, "vite.config.ts"),
      logLevel: "silent",
      build: { write: false },
    });
    assert.equal(
      await readFile(marker, "utf8"),
      "OWNER_SOURCE_WRITE_MARKER\n",
      "the unrestricted real Vite plugin must prove the owner-source write",
    );
    await rm(marker);

    await assert.rejects(
      () => assertProjectBoundaries(root, { verifyViteBuildGraph: true }),
      /constrained production Vite graph build failed[\s\S]*(FileSystemWrite|allow-fs-write)/,
    );
    await assert.rejects(
      () => readFile(marker, "utf8"),
      { code: "ENOENT" },
      "the constrained build must not create the owner-source marker",
    );
  });
});

test("rejects a temp output symlink redirected into owner source", async () => {
  await withFixture({}, async (root) => {
    await addMinimalViteEntries(root);
    const zuuliRoot = path.join(root, "zuuli");
    const ownerSink = path.join(zuuliRoot, "src/.output-escape");
    const marker = path.join(ownerSink, "symlink-write-marker");
    await mkdir(ownerSink);
    await writeFile(
      path.join(zuuliRoot, "vite.config.ts"),
      `import { rmSync, symlinkSync, writeFileSync } from "node:fs";
let outputDirectory;
export default { plugins: [{
  name: "output-symlink-writer",
  configResolved(config) { outputDirectory = config.build.outDir; },
  buildStart() {
    if (!outputDirectory.includes("wallet-boundary-vite-")) return;
    rmSync(outputDirectory, { recursive: true, force: true });
    symlinkSync(${JSON.stringify(ownerSink)}, outputDirectory, "dir");
    writeFileSync(outputDirectory + "/symlink-write-marker", "OUTPUT_SYMLINK_WRITE_MARKER\\n");
  },
}] };
`,
    );

    await assert.rejects(
      () => assertProjectBoundaries(root, { verifyViteBuildGraph: true }),
      ZUULI_CONSTRAINED_BUILD_FAILURE,
    );
    await assert.rejects(
      () => readFile(marker, "utf8"),
      { code: "ENOENT" },
      "the temp output path must not write through a symlink into owner source",
    );
  });
});

test("rejects one-shot config staging before the constrained build can audit it", async () => {
  await withFixture(
    {
      "zuuallet/src/one-shot-secret.ts":
        'export const oneShotSiblingSecret = "ONE_SHOT_SIBLING_SECRET_691";\n',
    },
    async (root) => {
      await addMinimalViteEntries(root);
      const zuuliRoot = path.join(root, "zuuli");
      const sibling = path.join(root, "zuuallet/src/one-shot-secret.ts");
      const staged = path.join(zuuliRoot, "src/.one-shot-staged.ts");
      await writeFile(
        path.join(zuuliRoot, "src/main.ts"),
        'import { oneShotSiblingSecret } from "./.one-shot-staged"; console.log(oneShotSiblingSecret);\n',
      );
      await writeFile(
        path.join(zuuliRoot, "vite.config.ts"),
        `import { copyFileSync, existsSync } from "node:fs";
if (!existsSync(${JSON.stringify(staged)})) {
  copyFileSync(${JSON.stringify(sibling)}, ${JSON.stringify(staged)});
}
export default {};
`,
      );
      const built = await viteBuild({
        root: zuuliRoot,
        configFile: path.join(zuuliRoot, "vite.config.ts"),
        logLevel: "silent",
        build: { write: false },
      });
      const generated = built.output
        .filter((output) => output.type === "chunk")
        .map((output) => output.code)
        .join("\n");
      assert.match(
        generated,
        /ONE_SHOT_SIBLING_SECRET_691/,
        "an unrestricted first config evaluation must prove it can stage and bundle sibling source",
      );
      assert.match(await readFile(staged, "utf8"), /ONE_SHOT_SIBLING_SECRET_691/);
      await rm(staged);

      await assert.rejects(
        () => assertProjectBoundaries(root, { verifyViteBuildGraph: true }),
        /Vite build configuration is not auditable[\s\S]*(one-shot-secret\.ts|FileSystemRead)/,
      );
      await assert.rejects(
        () => readFile(staged, "utf8"),
        { code: "ENOENT" },
        "the scanner must never stage owner source before its constrained audit",
      );
    },
  );
});

test("audits serve-mode top-level config effects inside the write sandbox", async () => {
  await withFixture({}, async (root) => {
    const zuuliRoot = path.join(root, "zuuli");
    const marker = path.join(zuuliRoot, "src/.serve-config-marker");
    const configFile = path.join(zuuliRoot, "vite.config.ts");
    await writeFile(
      configFile,
      `import { writeFileSync } from "node:fs";
export default ({ command }) => {
  if (command === "serve") writeFileSync(${JSON.stringify(marker)}, "SERVE_CONFIG_MARKER_691\\n");
  return {};
};
`,
    );
    await viteResolveConfig(
      {
        configFile,
        logLevel: "silent",
        mode: "development",
        root: zuuliRoot,
      },
      "serve",
      "development",
    );
    assert.equal(
      await readFile(marker, "utf8"),
      "SERVE_CONFIG_MARKER_691\n",
      "unrestricted serve config resolution must prove the top-level write",
    );
    await rm(marker);

    await assert.rejects(
      () => assertProjectBoundaries(root),
      /Vite serve configuration is not auditable[\s\S]*FileSystemWrite/,
    );
    await assert.rejects(
      () => readFile(marker, "utf8"),
      { code: "ENOENT" },
      "serve-mode configuration must not mutate owner source during the audit",
    );
  });
});

test("audits build-mode top-level config effects inside the write sandbox", async () => {
  await withFixture({}, async (root) => {
    const zuuliRoot = path.join(root, "zuuli");
    const marker = path.join(zuuliRoot, "src/.build-config-marker");
    const configFile = path.join(zuuliRoot, "vite.config.ts");
    await writeFile(
      configFile,
      `import { writeFileSync } from "node:fs";
export default ({ command }) => {
  if (command === "build") writeFileSync(${JSON.stringify(marker)}, "BUILD_CONFIG_MARKER_691\\n");
  return {};
};
`,
    );
    await viteResolveConfig(
      {
        configFile,
        logLevel: "silent",
        mode: "production",
        root: zuuliRoot,
      },
      "build",
      "production",
    );
    assert.equal(
      await readFile(marker, "utf8"),
      "BUILD_CONFIG_MARKER_691\n",
      "unrestricted build config resolution must prove the top-level write",
    );
    await rm(marker);

    await assert.rejects(
      () => assertProjectBoundaries(root),
      /Vite build configuration is not auditable[\s\S]*(FileSystemWrite|allow-fs-write)/,
    );
    await assert.rejects(
      () => readFile(marker, "utf8"),
      { code: "ENOENT" },
      "build-mode configuration must not mutate owner source during the audit",
    );
  });
});

test("rejects a Vite transform that reads sibling-app source after a real build proves injection", async () => {
  await withFixture(
    { "zuuallet/src/transform-secret.ts": "export const siblingSecret = 424242;\n" },
    async (root) => {
      await addMinimalViteEntries(root);
      const zuuliRoot = path.join(root, "zuuli");
      const sibling = path.join(root, "zuuallet/src/transform-secret.ts");
      await writeFile(
        path.join(zuuliRoot, "vite.config.ts"),
        `import { readFileSync } from "node:fs";
export default { plugins: [{
  name: "cross-app-transform",
  transform(code, id) {
    if (!id.endsWith("/src/main.ts")) return null;
    const sibling = readFileSync(${JSON.stringify(sibling)}, "utf8");
    return code + "\\nconsole.log(" + JSON.stringify(sibling) + ");";
  },
}] };
`,
      );
      const built = await viteBuild({
        root: zuuliRoot,
        configFile: path.join(zuuliRoot, "vite.config.ts"),
        logLevel: "silent",
        build: { write: false },
      });
      const generated = built.output
        .filter((output) => output.type === "chunk")
        .map((output) => output.code)
        .join("\n");
      assert.match(
        generated,
        /siblingSecret/,
        "the unrestricted production build must contain sibling source read by transform",
      );
      await assert.rejects(
        () => assertProjectBoundaries(root, { verifyViteBuildGraph: true }),
        ZUULI_CONSTRAINED_BUILD_FAILURE,
      );
    },
  );
});

test("rejects a Vite transform that delegates a sibling read to a child process", async () => {
  await withFixture(
    {
      "zuuallet/src/child-secret.ts":
        'export const childProcessSiblingSecret = "SensitiveEntryPurpose-child";\n',
    },
    async (root) => {
      await addMinimalViteEntries(root);
      const zuuliRoot = path.join(root, "zuuli");
      const sibling = path.join(root, "zuuallet/src/child-secret.ts");
      await writeFile(
        path.join(zuuliRoot, "vite.config.ts"),
        `import { execFileSync } from "node:child_process";
export default { plugins: [{
  name: "cross-app-child-transform",
  transform(code, id) {
    if (!id.endsWith("/src/main.ts")) return null;
    const sibling = execFileSync(process.execPath, [
      "-e",
      "const fs=require('node:fs');process.stdout.write(fs.readFileSync(process.argv[1],'utf8'))",
      ${JSON.stringify(sibling)},
    ], { encoding: "utf8" });
    return code + "\\nconsole.log(" + JSON.stringify(sibling) + ");";
  },
}] };
`,
      );
      const built = await viteBuild({
        root: zuuliRoot,
        configFile: path.join(zuuliRoot, "vite.config.ts"),
        logLevel: "silent",
        build: { write: false },
      });
      const generated = built.output
        .filter((output) => output.type === "chunk")
        .map((output) => output.code)
        .join("\n");
      assert.match(
        generated,
        /SensitiveEntryPurpose-child/,
        "the unrestricted production build must contain sibling source read by the child",
      );
      await assert.rejects(
        () => assertProjectBoundaries(root, { verifyViteBuildGraph: true }),
        /constrained production Vite graph build failed[\s\S]*allow-child-process/,
      );
    },
  );
});

test("rejects a Vite transform that delegates a sibling read to a worker", async () => {
  await withFixture(
    {
      "zuuallet/src/worker-secret.ts":
        'export const workerSiblingSecret = "SensitiveEntryPurpose-worker";\n',
    },
    async (root) => {
      await addMinimalViteEntries(root);
      const zuuliRoot = path.join(root, "zuuli");
      const sibling = path.join(root, "zuuallet/src/worker-secret.ts");
      await writeFile(
        path.join(zuuliRoot, "vite.config.ts"),
        `import { Worker } from "node:worker_threads";
export default { plugins: [{
  name: "cross-app-worker-transform",
  async transform(code, id) {
    if (!id.endsWith("/src/main.ts")) return null;
    const sibling = await new Promise((resolve, reject) => {
      const worker = new Worker(
        "const { parentPort, workerData } = require('node:worker_threads');" +
        "const fs = require('node:fs');" +
        "parentPort.postMessage(fs.readFileSync(workerData, 'utf8'));",
        { eval: true, execArgv: [], workerData: ${JSON.stringify(sibling)} },
      );
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    return code + "\\nconsole.log(" + JSON.stringify(sibling) + ");";
  },
}] };
`,
      );
      const built = await viteBuild({
        root: zuuliRoot,
        configFile: path.join(zuuliRoot, "vite.config.ts"),
        logLevel: "silent",
        build: { write: false },
      });
      const generated = built.output
        .filter((output) => output.type === "chunk")
        .map((output) => output.code)
        .join("\n");
      assert.match(
        generated,
        /SensitiveEntryPurpose-worker/,
        "the unrestricted production build must contain sibling source read by the worker",
      );
      await assert.rejects(
        () => assertProjectBoundaries(root, { verifyViteBuildGraph: true }),
        /constrained production Vite graph build failed[\s\S]*allow-worker/,
      );
    },
  );
});

test("rejects a Vite transform that copies sibling source into its owner before reading it", async () => {
  await withFixture(
    {
      "zuuallet/src/copy-secret.ts":
        'export const copiedSiblingSecret = "SensitiveEntryPurpose-copy";\n',
    },
    async (root) => {
      await addMinimalViteEntries(root);
      const zuuliRoot = path.join(root, "zuuli");
      const sibling = path.join(root, "zuuallet/src/copy-secret.ts");
      const copied = path.join(zuuliRoot, "src/.reviewer-copied.ts");
      await writeFile(
        path.join(zuuliRoot, "src/main.ts"),
        'import { copiedSiblingSecret } from "./.reviewer-copied"; console.log(copiedSiblingSecret);\n',
      );
      await writeFile(
        path.join(zuuliRoot, "vite.config.ts"),
        `import { copyFileSync, readFileSync } from "node:fs";
export default { plugins: [{
  name: "cross-app-copy-transform",
  transform(code, id) {
    if (!id.endsWith("/src/main.ts")) return null;
    copyFileSync(${JSON.stringify(sibling)}, ${JSON.stringify(copied)});
    readFileSync(${JSON.stringify(copied)}, "utf8");
    return code;
  },
}] };
`,
      );
      const built = await viteBuild({
        root: zuuliRoot,
        configFile: path.join(zuuliRoot, "vite.config.ts"),
        logLevel: "silent",
        build: { write: false },
      });
      const generated = built.output
        .filter((output) => output.type === "chunk")
        .map((output) => output.code)
        .join("\n");
      assert.match(
        generated,
        /SensitiveEntryPurpose-copy/,
        "the unrestricted production build must bundle sibling source copied into its owner",
      );
      assert.match(
        await readFile(copied, "utf8"),
        /SensitiveEntryPurpose-copy/,
        "the copied owner-local file must contain the sibling source",
      );
      await assert.rejects(
        () => assertProjectBoundaries(root, { verifyViteBuildGraph: true }),
        /constrained production Vite graph build failed[\s\S]*(copy-secret\.ts|FileSystem(Read|Write)|allow-fs-(read|write))/,
      );
    },
  );
});

test("rejects a Vite transform that copies sibling source into the permitted output", async () => {
  await withFixture(
    {
      "zuuallet/src/output-copy-secret.ts":
        'export const outputCopiedSiblingSecret = "OUTPUT_COPY_SECRET_691";\n',
    },
    async (root) => {
      await addMinimalViteEntries(root);
      const zuuliRoot = path.join(root, "zuuli");
      const sibling = path.join(root, "zuuallet/src/output-copy-secret.ts");
      await writeFile(
        path.join(zuuliRoot, "vite.config.ts"),
        `import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
let outputDirectory;
export default { plugins: [{
  name: "cross-app-output-copy-transform",
  configResolved(config) { outputDirectory = config.build.outDir; },
  transform(code, id) {
    if (!id.endsWith("/src/main.ts")) return null;
    mkdirSync(outputDirectory, { recursive: true });
    const copied = path.join(outputDirectory, ".output-copied.ts");
    copyFileSync(${JSON.stringify(sibling)}, copied);
    const secret = readFileSync(copied, "utf8");
    return code + "\\nconsole.log(" + JSON.stringify(secret) + ");";
  },
}] };
`,
      );
      const built = await viteBuild({
        root: zuuliRoot,
        configFile: path.join(zuuliRoot, "vite.config.ts"),
        logLevel: "silent",
        build: { write: false },
      });
      const generated = built.output
        .filter((output) => output.type === "chunk")
        .map((output) => output.code)
        .join("\n");
      assert.match(
        generated,
        /OUTPUT_COPY_SECRET_691/,
        "the unrestricted build must prove a sibling read can be staged through its output",
      );

      await assert.rejects(
        () => assertProjectBoundaries(root, { verifyViteBuildGraph: true }),
        /constrained production Vite graph build failed[\s\S]*(output-copy-secret\.ts|allow-fs-read)/,
      );
    },
  );
});

test("production boundary rejects a Vite load hook that reads sibling-app source", async () => {
  await withFixture(
    { "zuuallet/src/load-secret.ts": "export const siblingLoadSecret = 515151;\n" },
    async (root) => {
      await addMinimalViteEntries(root);
      const zuuliRoot = path.join(root, "zuuli");
      const sibling = path.join(root, "zuuallet/src/load-secret.ts");
      await writeFile(
        path.join(zuuliRoot, "src/main.ts"),
        'import { injected } from "./local"; console.log(injected);\n',
      );
      await writeFile(
        path.join(zuuliRoot, "vite.config.ts"),
        `import { readFileSync } from "node:fs";
export default { plugins: [{
  name: "cross-app-load",
  load(id) {
    if (!id.endsWith("/src/local.ts")) return null;
    const sibling = readFileSync(${JSON.stringify(sibling)}, "utf8");
    return "export const injected = " + JSON.stringify(sibling) + ";";
  },
}] };
`,
      );
      const built = await viteBuild({
        root: zuuliRoot,
        configFile: path.join(zuuliRoot, "vite.config.ts"),
        logLevel: "silent",
        build: { write: false },
      });
      const generated = built.output
        .filter((output) => output.type === "chunk")
        .map((output) => output.code)
        .join("\n");
      assert.match(
        generated,
        /siblingLoadSecret/,
        "the unrestricted production build must contain sibling source read by load",
      );
      await assert.rejects(
        () => runProductionBoundary({ walletRoot: root }),
        ZUULI_CONSTRAINED_BUILD_FAILURE,
      );
    },
  );
});

test("rejects a CSS import of sibling-app source after a real build proves bundling", async () => {
  await withFixture(
    {
      "zuuli/src/main.ts": 'import "./index.css";\n',
      "zuuli/src/index.css":
        '@import "../../zuuallet/src/index.css";\n.owner { color: blue; }\n',
      "zuuallet/src/index.css": ".classic-secret { color: rgb(1, 2, 3); }\n",
    },
    async (root) => {
      await addMinimalViteEntries(root);
      await writeFile(path.join(root, "zuuli/src/main.ts"), 'import "./index.css";\n');
      const zuuliRoot = path.join(root, "zuuli");
      const built = await viteBuild({
        root: zuuliRoot,
        configFile: path.join(zuuliRoot, "vite.config.ts"),
        logLevel: "silent",
        build: { write: false },
      });
      const generated = built.output
        .filter((output) => output.type === "asset")
        .map((output) => String(output.source))
        .join("\n");
      assert.match(
        generated,
        /classic-secret/,
        "the unrestricted production build must bundle sibling CSS",
      );
      await assert.rejects(
        () => assertProjectBoundaries(root, { verifyViteBuildGraph: true }),
        ZUULI_CONSTRAINED_BUILD_FAILURE,
      );
    },
  );
});

test("accepts constrained Vite transforms and CSS imports that stay owner-local or shared", async () => {
  await withFixture(
    {
      "zuuli/src/main.ts": 'import "./index.css";\n',
      "zuuli/src/index.css": '@import "./local.css";\n.owner { color: blue; }\n',
      "zuuli/src/local.css": ".local { color: green; }\n",
    },
    async (root) => {
      await addMinimalViteEntries(root);
      await writeFile(path.join(root, "zuuli/src/main.ts"), 'import "./index.css";\n');
      await writeFile(
        path.join(root, "zuuli/vite.config.ts"),
        `import { readFileSync } from "node:fs";
export default { plugins: [{
  name: "owner-transform",
  transform(code, id) {
    if (!id.endsWith("/src/main.ts")) return null;
    const local = readFileSync(new URL("./src/local.ts", import.meta.url), "utf8");
    const shared = readFileSync(new URL("../shared/src/index.ts", import.meta.url), "utf8");
    return code + "\\nconsole.log(" + JSON.stringify(local.length + shared.length) + ");";
  },
}] };
`,
      );
      await assert.doesNotReject(() =>
        assertProjectBoundaries(root, { verifyViteBuildGraph: true }),
      );
    },
  );
});

test("rejects parent traversal supplied through an otherwise local path alias", async () => {
  await withFixture(
    { "zuuli/src/aliased.ts": 'import "@/../../../zuuallet/src/local";\n' },
    async (root) => {
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /TypeScript path alias @\/\* resolves outside wallet\/zuuli/,
      );
    },
  );
});

test("rejects traversal after a wildcard in any one of multiple path targets", async () => {
  await withFixture(
    {},
    async (root) => {
      await writeFile(
        path.join(root, "zuuli/tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["./src/*"],
              "@multi/*": [
                "./src/*",
                "./src/*/../../../zuuallet/src/local.ts",
              ],
            },
          },
          include: ["src"],
        }),
      );
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /TypeScript path alias @multi\/\* escapes wallet\/zuuli/,
      );
    },
  );
});

test("allows multiple local path targets and an in-project symlink target", async () => {
  await withFixture(
    {
      "zuuli/src/aliased.ts": [
        'import "@multi/local";',
        'import "@linked/local";',
      ].join("\n"),
    },
    async (root) => {
      await mkdir(path.join(root, "zuuli/aliases"), { recursive: true });
      await symlink(path.join(root, "zuuli/src"), path.join(root, "zuuli/aliases/local"));
      await writeFile(
        path.join(root, "zuuli/tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@multi/*": ["./src/*", "./src/nested/*"],
              "@linked/*": ["./aliases/*"],
            },
          },
          include: ["src"],
        }),
      );
      await assert.doesNotReject(() => assertProjectBoundaries(root));
    },
  );
});

test("rejects an import whose wildcard substitution crosses through a symlink", async () => {
  await withFixture(
    { "zuuli/src/aliased.ts": 'import "@linked/classic/local";\n' },
    async (root) => {
      await mkdir(path.join(root, "zuuli/aliases"), { recursive: true });
      await symlink(
        path.join(root, "zuuallet/src"),
        path.join(root, "zuuli/aliases/classic"),
      );
      await writeFile(
        path.join(root, "zuuli/tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "@linked/*": ["./aliases/*"] },
          },
          include: ["src"],
        }),
      );
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /TypeScript path alias @linked\/\* resolves outside wallet\/zuuli/,
      );
    },
  );
});

test("fails loud when an alias target has a broken symlink component", async () => {
  await withFixture({}, async (root) => {
    await mkdir(path.join(root, "zuuli/aliases"), { recursive: true });
    await symlink(
      path.join(root, "missing-target"),
      path.join(root, "zuuli/aliases/broken"),
    );
    await writeFile(
      path.join(root, "zuuli/tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@broken/*": ["./aliases/broken/*"] },
        },
        include: ["src"],
      }),
    );
    await assert.rejects(
      () => assertProjectBoundaries(root),
      /contains a broken symbolic link.*aliases\/broken/,
    );
  });
});

test("allows the named shared alias only when it resolves inside wallet/shared", async () => {
  await withFixture({}, async (root) => {
    await writeFile(
      path.join(root, "zuuli/tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["./src/*"],
            "@free2z/wallet-shared": ["../shared/src/index.ts"],
          },
        },
        include: ["src"],
      }),
    );
    await assert.doesNotReject(() => assertProjectBoundaries(root));
  });
});

test("rejects a named shared alias that shadows the package inside an app", async () => {
  await withFixture({}, async (root) => {
    await writeFile(
      path.join(root, "zuuli/tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@free2z/wallet-shared": ["./src/local.ts"] },
        },
        include: ["src"],
      }),
    );
    await assert.rejects(
      () => assertProjectBoundaries(root),
      /named shared TypeScript path alias must resolve inside wallet\/shared/,
    );
  });
});

test("rejects a broad path alias that shadows the named shared package", async () => {
  await withFixture({}, async (root) => {
    await writeFile(
      path.join(root, "zuuli/tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@free2z/*": ["./src/*"] },
        },
        include: ["src"],
      }),
    );
    await assert.rejects(
      () => assertProjectBoundaries(root),
      /named shared import is shadowed by TypeScript path alias @free2z\/\*/,
    );
  });
});

test("rejects a source symlink that could cross a project boundary", async () => {
  await withFixture({}, async (root) => {
    await symlink(
      path.join(root, "zuuallet/src/local.ts"),
      path.join(root, "zuuli/src/linked-classic.ts"),
    );
    await assert.rejects(
      () => assertProjectBoundaries(root),
      /project source contains a symbolic link/,
    );
  });
});

test("rejects a project whose source root is itself a symlink", async () => {
  await withFixture({}, async (root) => {
    await mkdir(path.join(root, "future-wallet"), { recursive: true });
    await writeFile(
      path.join(root, "future-wallet/package.json"),
      JSON.stringify({ name: "future-wallet", private: true }),
    );
    await symlink(path.join(root, "shared/src"), path.join(root, "future-wallet/src"));
    await assert.rejects(
      () => assertProjectBoundaries(root),
      /wallet project source root contains a symbolic link/,
    );
  });
});

test("does not mistake comments or strings for imports", async () => {
  await withFixture(
    {
      "zuuli/src/text.ts": [
        '// import "../../../zuuallet/src/local";',
        'const documentation = "require(\\\"../../../zuuallet/src/local\\\")";',
        "void documentation;",
      ].join("\n"),
    },
    async (root) => {
      await assert.doesNotReject(() => assertProjectBoundaries(root));
    },
  );
});

test("rejects the named shared package when the app does not declare it", async () => {
  await withFixture(
    { "zuuli/src/shared.ts": 'import "@free2z/wallet-shared";\n' },
    async (root) => {
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /imports @free2z\/wallet-shared without its exact declared dependency/,
      );
    },
    { zuuli: {}, zuuallet: SHARED_DEPENDENCY },
  );
});

for (const [protocol, value] of [
  ["file", "file:../zuuallet"],
  ["link", "link:../zuuallet"],
  ["workspace", "workspace:*"],
  ["local path", "../zuuallet"],
]) {
  test(`rejects a non-shared ${protocol} dependency alias`, async () => {
    await withFixture({}, async (root) => {
      const manifestFile = path.join(root, "zuuli/package.json");
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      manifest.dependencies.classic = value;
      await writeFile(manifestFile, JSON.stringify(manifest));
      await assert.rejects(
        () => assertProjectBoundaries(root),
        new RegExp(`non-shared dependency alias dependencies\\.classic may not use ${protocol.replace(" ", "\\s")}`),
      );
    });
  });
}

test("rejects an npm dependency alias to another wallet app, including subpath imports", async () => {
  await withFixture(
    { "zuuli/src/alias.ts": 'import "classic/src/local";\n' },
    async (root) => {
      const manifestFile = path.join(root, "zuuli/package.json");
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      manifest.dependencies.classic = "npm:zuuallet@1.0.0";
      await writeFile(manifestFile, JSON.stringify(manifest));
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /dependency alias classic resolves to wallet\/zuuallet/,
      );
    },
  );
});

test("allows an npm alias to an external dependency", async () => {
  await withFixture(
    { "zuuli/src/alias.ts": 'import "react-compat/jsx-runtime";\n' },
    async (root) => {
      const manifestFile = path.join(root, "zuuli/package.json");
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      manifest.dependencies["react-compat"] = "npm:react@18.3.1";
      await writeFile(manifestFile, JSON.stringify(manifest));
      await assert.doesNotReject(() => assertProjectBoundaries(root));
    },
  );
});

test("rejects an application manifest that omits the shared dependency", async () => {
  await withFixture(
    {},
    async (root) => {
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /zuuli\/package\.json: zuuli must declare @free2z\/wallet-shared as file:\.\.\/shared/,
      );
    },
    { zuuli: {}, zuuallet: SHARED_DEPENDENCY },
  );
});

test("rejects a production consumer that drops its named shared import", async () => {
  await withFixture(
    { "zuuli/src/lib/wallet/bridge.ts": "export const bridge = true;\n" },
    async (root) => {
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /zuuli\/src\/lib\/wallet\/bridge\.ts: production consumer must import @free2z\/wallet-shared/,
      );
    },
  );
});

test("rejects a decorative workspace list that omits the shared package", async () => {
  await withFixture({}, async (root) => {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: [] }),
    );
    await assert.rejects(
      () => assertProjectBoundaries(root),
      /must declare the exact shared workspace/,
    );
  });
});

for (const [label, mutate, expected] of [
  [
    "name",
    (manifest) => { manifest.name = "@free2z/not-wallet-shared"; },
    /wallet\/shared package name must equal @free2z\/wallet-shared/,
  ],
  [
    "private flag",
    (manifest) => { manifest.private = false; },
    /wallet\/shared package must remain private/,
  ],
  [
    "module type",
    (manifest) => { manifest.type = "commonjs"; },
    /wallet\/shared package type must equal "module"/,
  ],
  [
    "source export",
    (manifest) => { manifest.exports = {}; },
    /wallet\/shared package exports must equal exactly/,
  ],
]) {
  test(`rejects a shared manifest with the wrong ${label}`, async () => {
    await withFixture({}, async (root) => {
      const manifest = {
        name: "@free2z/wallet-shared",
        private: true,
        type: "module",
        exports: { ".": "./src/index.ts" },
      };
      mutate(manifest);
      await writeFile(
        path.join(root, "shared/package.json"),
        JSON.stringify(manifest),
      );
      await assert.rejects(() => assertProjectBoundaries(root), expected);
    });
  });
}

for (const [label, extraExport] of [
  ["extra subpath", "./src/helper.ts"],
  ["escaping subpath", "../zuuallet/src/local.ts"],
]) {
  test(`rejects a shared manifest with an ${label} export`, async () => {
    await withFixture({}, async (root) => {
      const manifestFile = path.join(root, "shared/package.json");
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      manifest.exports["./helper"] = extraExport;
      await writeFile(manifestFile, JSON.stringify(manifest));
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /wallet\/shared package exports must equal exactly/,
      );
    });
  });
}

for (const consumer of REQUIRED_PRODUCTION_CONSUMERS) {
  test(`rejects a decorative side-effect shared import in ${consumer}`, async () => {
    await withFixture(
      { [consumer]: 'import "@free2z/wallet-shared";\n' },
      async (root) => {
        await assert.rejects(
          () => assertProjectBoundaries(root),
          /production consumer must have one auditable named import/,
        );
      },
    );
  });
}

test("rejects a named shared binding that is decorative beside a copied local type", async () => {
  await withFixture(
    {
      "zuuli/src/lib/wallet/bridge.ts": [
        'import type { SensitiveEntryPurpose } from "@free2z/wallet-shared";',
        "type DecorativeOne = SensitiveEntryPurpose;",
        "type DecorativeTwo = SensitiveEntryPurpose;",
        'type CopiedPurpose = "seedImport" | "seedBackup";',
        "export const wallet = {",
        "  beginSensitiveEntry(purpose: CopiedPurpose) { return purpose; },",
        "  endSensitiveDisplay(purpose: CopiedPurpose) { return purpose; },",
        "};",
      ].join("\n"),
    },
    async (root) => {
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /shared binding SensitiveEntryPurpose must have exact uses .*; found other:TypeReference, other:TypeReference/,
      );
    },
  );
});

test("does not count a shadowed local name as use of a shared binding", async () => {
  await withFixture(
    {
      "zuuli/src/lib/wallet/bridge.ts": [
        'import type { SensitiveEntryPurpose } from "@free2z/wallet-shared";',
        "namespace LocalScope {",
        '  export type SensitiveEntryPurpose = "copied";',
        "  export type One = SensitiveEntryPurpose;",
        "  export type Two = SensitiveEntryPurpose;",
        "}",
      ].join("\n"),
    },
    async (root) => {
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /shared binding SensitiveEntryPurpose must have exact uses .*; found none/,
      );
    },
  );
});

test("rejects an extra decorative named binding in a production consumer", async () => {
  await withFixture(
    {
      "zuuli/src/lib/wallet/bridge.ts": REQUIRED_PRODUCTION_SOURCES.get(
        "zuuli/src/lib/wallet/bridge.ts",
      ).replace("SensitiveEntryPurpose }", "SensitiveEntryPurpose, SensitiveEntrySession }"),
    },
    async (root) => {
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /production consumer must import exactly SensitiveEntryPurpose/,
      );
    },
  );
});

test("rejects a production type binding imported as a runtime value", async () => {
  await withFixture(
    {
      "zuuli/src/lib/wallet/bridge.ts": REQUIRED_PRODUCTION_SOURCES.get(
        "zuuli/src/lib/wallet/bridge.ts",
      ).replace("import type", "import"),
    },
    async (root) => {
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /SensitiveEntryPurpose must be a type-only named binding/,
      );
    },
  );
});

test("rejects a lockfile that does not resolve shared as a workspace link", async () => {
  await withFixture({}, async (root) => {
    await writeFile(
      path.join(root, "package-lock.json"),
      JSON.stringify({
        packages: {
          "node_modules/@free2z/wallet-shared": {
            resolved: "https://registry.invalid/wallet-shared.tgz",
          },
        },
      }),
    );
    await assert.rejects(
      () => assertProjectBoundaries(root),
      /must resolve the named shared workspace as a local link/,
    );
  });
});

test("rejects parent traversal hidden behind the shared package name", async () => {
  await withFixture(
    { "zuuli/src/shared.ts": 'import "@free2z/wallet-shared/../zuuallet/src/local";\n' },
    async (root) => {
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /shared package import may not traverse parent segments/,
      );
    },
  );
});

test("rejects an unexported named shared package subpath", async () => {
  await withFixture(
    { "zuuli/src/shared.ts": 'import "@free2z/wallet-shared/helper";\n' },
    async (root) => {
      await assert.rejects(
        () => assertProjectBoundaries(root),
        /@free2z\/wallet-shared exposes only its package root/,
      );
    },
  );
});

test("fails loud on source syntax the parser cannot classify", async () => {
  await withFixture(
    { "zuuli/src/broken.ts": 'import { from "./local";\n' },
    async (root) => {
      await assert.rejects(() => assertProjectBoundaries(root), /broken\.ts:1:/);
    },
  );
});

// ---------------------------------------------------------------------------
// #905: the intent bridge is one implementation, and these are the negative
// controls that prove the rule is not decorative. Each fails only because the
// scanner refuses a specific way of getting a second copy.
// ---------------------------------------------------------------------------

test("rejects a second intent-bridge implementation inside an application", async () => {
  await withFixture(
    {
      "zuuli/src/intent/wire.ts": [
        "export const INTENT_PROTOCOL_VERSION = 1;",
        "export function encodeIntentRequest(request: unknown) { return request; }",
      ].join("\n"),
    },
    async (root) => {
      await assert.rejects(
        assertProjectBoundaries(root),
        /INTENT_PROTOCOL_VERSION may only be declared inside wallet\/shared\/src\/intent/,
      );
    },
  );
});

test("rejects a second implementation smuggled in as a local helper", async () => {
  // The realistic shape: not a whole module, one function an app decided was
  // easier to write than to import.
  await withFixture(
    {
      "zuuallet/src/lib/link.ts": [
        "const decodeIntentResponse = (bytes: Uint8Array) => bytes;",
        "export const read = (bytes: Uint8Array) => decodeIntentResponse(bytes);",
      ].join("\n"),
    },
    async (root) => {
      await assert.rejects(
        assertProjectBoundaries(root),
        /decodeIntentResponse may only be declared inside wallet\/shared\/src\/intent/,
      );
    },
  );
});

test("rejects an application minting a label in the bridge's domain namespace", async () => {
  await withFixture(
    {
      "zuuli/src/lib/labels.ts":
        'export const label = "free2z/intent/v1/request";\n',
    },
    async (root) => {
      await assert.rejects(
        assertProjectBoundaries(root),
        /the free2z\/intent\/v1\/ domain namespace belongs to wallet\/shared\/src\/intent/,
      );
    },
  );
});

test("accepts an application that imports the shared implementation", async () => {
  await withFixture(
    {
      "zuuli/src/lib/link.ts": [
        'import { encodeIntentRequest, INTENT_PROTOCOL_VERSION } from "@free2z/wallet-shared";',
        "export const send = (request: unknown) => encodeIntentRequest(request);",
        "export const version = INTENT_PROTOCOL_VERSION;",
      ].join("\n"),
    },
    async (root) => {
      await assert.doesNotReject(assertProjectBoundaries(root));
    },
  );
});

test("rejects a shared package that stops re-exporting the intent bridge", async () => {
  await withFixture(
    { "shared/src/index.ts": "export const nothing = true;\n" },
    async (root) => {
      await assert.rejects(
        assertProjectBoundaries(root),
        /must re-export \.\/intent so the single intent-bridge implementation is reachable/,
      );
    },
  );
});

test("rejects an intent bridge that quietly loses a guard", async () => {
  // The #553 shape: a check whose subject can shrink without the check
  // noticing. Deleting the version gate must fail here, not go unmentioned.
  await withFixture(
    {
      "shared/src/intent/index.ts": [
        "export function encodeIntentRequest(request: unknown) { return request; }",
        "export function decodeIntentResponse(bytes: unknown) { return bytes; }",
        "export function createIntentSession() { return {}; }",
        "export function parseVisibleText(bytes: unknown) { return String(bytes); }",
      ].join("\n"),
    },
    async (root) => {
      await assert.rejects(
        assertProjectBoundaries(root),
        /must declare INTENT_PROTOCOL_VERSION; a guard nobody declares is a guard nobody applies/,
      );
    },
  );
});

test("rejects a wallet tree with no intent-bridge implementation at all", async () => {
  const root = await fixture();
  try {
    await rm(path.join(root, "shared/src/intent"), { recursive: true, force: true });
    await assert.rejects(
      assertProjectBoundaries(root),
      /the single intent-bridge implementation must exist/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
