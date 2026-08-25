import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertProjectBoundaries } from "./project-boundary.mjs";

const SHARED_DEPENDENCY = { "@free2z/wallet-shared": "file:../shared" };
const REQUIRED_PRODUCTION_CONSUMERS = [
  "zuuallet/src/lib/sensitive-entry.ts",
  "zuuallet/src/lib/tauri.ts",
  "zuuli/src/lib/wallet/bridge.ts",
  "zuuli/src/lib/wallet/mock.ts",
  "zuuli/src/lib/wallet/sensitive-entry.ts",
];

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
      JSON.stringify({ name: project, private: true, dependencies }),
    );
    await writeFile(path.join(root, project, "src/local.ts"), "export const local = true;\n");
  }
  for (const relative of REQUIRED_PRODUCTION_CONSUMERS) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'import "@free2z/wallet-shared";\n');
  }
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return root;
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
        'export { helper } from "@free2z/wallet-shared/helper";',
        "void local; void React; void shared;",
      ].join("\n"),
      "zuuallet/src/nested/consumer.ts": [
        'const shared = import("@free2z/wallet-shared/session");',
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

test("rejects a shared manifest that drops its resolvable source export", async () => {
  await withFixture({}, async (root) => {
    await writeFile(
      path.join(root, "shared/package.json"),
      JSON.stringify({
        name: "@free2z/wallet-shared",
        private: true,
        type: "module",
        exports: {},
      }),
    );
    await assert.rejects(
      () => assertProjectBoundaries(root),
      /must retain its private ESM @free2z\/wallet-shared package identity and source export/,
    );
  });
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

test("fails loud on source syntax the parser cannot classify", async () => {
  await withFixture(
    { "zuuli/src/broken.ts": 'import { from "./local";\n' },
    async (root) => {
      await assert.rejects(() => assertProjectBoundaries(root), /broken\.ts:1:/);
    },
  );
});
