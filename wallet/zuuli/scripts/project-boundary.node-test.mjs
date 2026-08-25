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
import { build as viteBuild } from "vite";
import { assertProjectBoundaries } from "./project-boundary.mjs";

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
  await writeFile(path.join(root, "shared/src/index.ts"), "export {};\n");
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

test("current wallet source graph has no undeclared project crossing", async () => {
  const walletRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const result = await assertProjectBoundaries(walletRoot);
  assert.ok(result.fileCount > 100, "live census must traverse both application source trees");
  assert.ok(result.importCount > 300, "live census must parse the production module graph");
  assert.deepEqual(
    result.projectDirectories,
    ["shared", "zuuallet", "zuuli"],
    "live project population must match every manifest-backed wallet source tree",
  );
  assert.equal(
    result.productionSharedConsumerCount,
    5,
    "all five production shared consumers must use the named package",
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
