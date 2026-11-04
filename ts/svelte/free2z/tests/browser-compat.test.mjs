import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import { ESLint } from "eslint";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const eslintBin = join(packageRoot, "node_modules/eslint/bin/eslint.js");
const eslint = new ESLint({ cwd: packageRoot });
let stylishFormatter;

function runEslintCli(args, input = "") {
  return spawnSync(process.execPath, [eslintBin, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    input,
  });
}

async function runEslint(filename, input) {
  const [result] = await eslint.lintText(input, {
    filePath: join(packageRoot, filename),
  });
  stylishFormatter ??= await eslint.loadFormatter("stylish");
  return {
    error: undefined,
    status: result.errorCount > 0 ? 1 : 0,
    stdout: await stylishFormatter.format([result]),
    stderr: "",
  };
}

function assertRuntimeFloorDiagnostic(diagnostics, label) {
  assert.match(
    diagnostics,
    /free2z-runtime\/compatibility-floor/,
    `${label} was not reported by the generalized runtime-floor rule`,
  );
  assert.match(
    diagnostics,
    /is above the browser baseline; use a compatible alternative/,
    `${label} did not use the runtime-floor message`,
  );
}

function runtimeFloorCount(diagnostics) {
  return (diagnostics.match(/free2z-runtime\/compatibility-floor/g) ?? [])
    .length;
}

test("compatibility gate rejects known unsupported ES APIs", async () => {
  const unsupportedApis = [
    [
      "Object.groupBy",
      "Object.groupBy([], () => 1);",
      /free2z-runtime\/compatibility-floor/,
    ],
    [
      "Promise.withResolvers",
      "Promise.withResolvers();",
      /free2z-runtime\/compatibility-floor/,
    ],
    [
      "Array.fromAsync",
      "Array.fromAsync([]);",
      /free2z-runtime\/compatibility-floor/,
    ],
    [
      "RegExp.escape",
      'RegExp.escape("x");',
      /free2z-runtime\/compatibility-floor/,
    ],
    [
      "Set.prototype.union",
      "Set.prototype.union.call(new Set(), new Set());",
      /free2z-runtime\/compatibility-floor/,
    ],
    [
      'Set.prototype["union"]',
      'Set.prototype["union"].call(new Set(), new Set());',
      /free2z-runtime\/compatibility-floor/,
    ],
    [
      "new Set().union",
      "new Set().union(new Set());",
      /free2z-runtime\/compatibility-floor/,
    ],
    [
      'new Set()["union"]',
      'new Set()["union"](new Set());',
      /free2z-runtime\/compatibility-floor/,
    ],
  ];

  for (const [api, source] of unsupportedApis) {
    const result = await runEslint("src/lib/compat-contract.js", source);
    const diagnostics = `${result.stdout}${result.stderr}`;
    assert.equal(result.error, undefined, `${api} probe could not run`);
    assert.notEqual(
      result.status,
      0,
      `${api} unexpectedly passed the browser compatibility gate:\n${result.stdout}${result.stderr}`,
    );
    assertRuntimeFloorDiagnostic(diagnostics, api);
  }
});

test("scope-aware compatibility guard rejects aliased Set and RegExp APIs", async () => {
  const unsupportedApis = [
    [
      "Set-valued variable",
      "const left = new Set(); left.union(new Set());",
      "src/lib/compat-contract.js",
    ],
    [
      "typed Set parameter",
      "function merge(values: Set<number>) { values.union(new Set()); }",
      "src/lib/compat-contract.ts",
    ],
    [
      "globalThis.Set.prototype.union",
      "globalThis.Set.prototype.union.call(new Set(), new Set());",
      "src/lib/compat-contract.js",
    ],
    [
      "global Set constructor alias",
      "const RuntimeSet = Set; new RuntimeSet().union(new RuntimeSet());",
      "src/lib/compat-contract.js",
    ],
    [
      "globalThis Set constructor alias",
      "const RuntimeSet = globalThis.Set; new RuntimeSet().union(new RuntimeSet());",
      "src/lib/compat-contract.js",
    ],
    [
      "globalThis.RegExp.escape",
      'globalThis.RegExp.escape("x");',
      "src/lib/compat-contract.js",
    ],
    [
      "RegExp constructor alias",
      'const RuntimeRegExp = RegExp; RuntimeRegExp.escape("x");',
      "src/lib/compat-contract.js",
    ],
    [
      "globalThis.RegExp constructor alias",
      'const RuntimeRegExp = globalThis.RegExp; RuntimeRegExp.escape("x");',
      "src/lib/compat-contract.js",
    ],
    [
      "Object constructor alias",
      "const RuntimeObject = Object; RuntimeObject.groupBy([], () => 1);",
      "src/lib/compat-contract.js",
    ],
    [
      "Promise constructor alias",
      "const RuntimePromise = Promise; RuntimePromise.withResolvers();",
      "src/lib/compat-contract.js",
    ],
    [
      "Array constructor alias",
      "const RuntimeArray = Array; RuntimeArray.fromAsync([]);",
      "src/lib/compat-contract.js",
    ],
    [
      "AbortSignal constructor alias",
      "const RuntimeAbortSignal = AbortSignal; RuntimeAbortSignal.any([]); RuntimeAbortSignal.timeout(1);",
      "src/lib/compat-contract.js",
    ],
  ];

  for (const [api, source, filename] of unsupportedApis) {
    const result = await runEslint(filename, source);
    const diagnostics = `${result.stdout}${result.stderr}`;

    assert.equal(result.error, undefined, `${api} probe could not run`);
    assert.notEqual(
      result.status,
      0,
      `${api} unexpectedly passed the scope-aware compatibility gate:\n${diagnostics}`,
    );
    assert.match(
      diagnostics,
      /free2z-runtime\/compatibility-floor/,
      `${api} failed for an unrelated rule:\n${diagnostics}`,
    );
    assert.match(
      diagnostics,
      /is above the browser baseline; use a compatible alternative/,
    );
  }
});

test("scope-aware compatibility guard ignores shadowed and unrelated APIs", async () => {
  const supportedSources = [
    ["shadowed Set class", "class Set { union() {} } new Set().union();"],
    [
      "shadowed RegExp object",
      'const RegExp = { escape() { return "ok"; } }; RegExp.escape("x");',
    ],
    [
      "unrelated union methods",
      "const value = { union: () => 1 }; value.union(); new Map().union(new Map());",
    ],
    [
      "unrelated constructor aliases",
      "const RuntimeSet = class { union() {} }; new RuntimeSet().union();",
    ],
  ];

  for (const [api, source] of supportedSources) {
    const result = await runEslint("src/lib/compat-contract.js", source);

    assert.equal(
      result.status,
      0,
      `${api} unexpectedly failed the compatibility gate:\n${result.stdout}${result.stderr}`,
    );
  }
});

test("runtime floor follows source-order assignments conservatively", async () => {
  const probes = [
    [
      "Set reassigned before access",
      "let RuntimeSet = class {}; RuntimeSet = Set; new RuntimeSet().union();",
      true,
    ],
    [
      "Set reassigned after access",
      "let RuntimeSet = Set; new RuntimeSet().union(); RuntimeSet = class {};",
      true,
    ],
    [
      "Set replaced before access",
      "let RuntimeSet = Set; RuntimeSet = class {}; new RuntimeSet().union();",
      false,
    ],
    [
      "RegExp alias reassigned before access",
      'let RuntimeRegExp = RegExp; RuntimeRegExp = RegExp; RuntimeRegExp.escape("x");',
      true,
    ],
    [
      "RegExp alias replaced before access",
      'let RuntimeRegExp = RegExp; RuntimeRegExp = {}; RuntimeRegExp.escape("x");',
      false,
    ],
    [
      "typed parameter reassigned to custom value",
      "function f(value: Set<number>) { value = new Map() as any; value.union(); }",
      false,
    ],
    [
      "typed parameter reassigned to Set",
      "function f(value: Set<number>) { value = new Set(); value.union(); }",
      true,
    ],
    [
      "destructured union",
      "const { union } = new Set(); union.call(new Set(), new Set());",
      true,
    ],
    ["destructured escape", 'const { escape } = RegExp; escape("x");', true],
    [
      "destructured constructor method",
      "const { groupBy } = Object; groupBy([], () => 1);",
      true,
    ],
    [
      "destructured Set prototype method",
      "const { prototype: { union } } = Set; union.call(new Set(), new Set());",
      true,
    ],
    [
      "destructured globalThis method",
      "const { RegExp: { escape } } = globalThis; escape('x');",
      true,
    ],
    [
      "constant computed method",
      'const method = "union"; new Set()[method](new Set()); RegExp[`escape`] ("x");',
      true,
    ],
    [
      "type alias and assertion",
      "type RuntimeSet = Set<number>; const value = ({} as RuntimeSet); value.union();",
      true,
    ],
    [
      "uncalled nested closure does not rewrite the outer alias",
      "let RuntimeSet = Set; function replace() { RuntimeSet = class {}; } new RuntimeSet().union();",
      true,
    ],
    [
      "called nested closure rewrites the outer alias",
      "let RuntimeSet = Set; function replace() { RuntimeSet = class {}; } replace(); new RuntimeSet().union();",
      false,
    ],
    [
      "branch with a possible custom replacement is unknown",
      "let RuntimeSet = Set; if (flag) RuntimeSet = class {}; new RuntimeSet().union();",
      false,
    ],
    [
      "branch with only built-in values remains proven",
      "let RuntimeSet = Set; if (flag) RuntimeSet = Set; new RuntimeSet().union();",
      true,
    ],
    [
      "destructuring assignment",
      "let union; ({ union } = new Set()); union.call(new Set(), new Set());",
      true,
    ],
    [
      "computed destructuring assignment",
      'const key = "escape"; const { [key]: escape } = RegExp; escape("x");',
      true,
    ],
    [
      "nested same-named Map type alias is not a Set",
      "type RuntimeSet = Set<number>; { type RuntimeSet = Map<number>; const value = ({} as RuntimeSet); value.union(); }",
      false,
    ],
  ];

  for (const [name, source, shouldFail] of probes) {
    const result = await runEslint("src/lib/compat-contract.ts", source);
    const diagnostics = `${result.stdout}${result.stderr}`;
    assert.equal(result.error, undefined, `${name} probe could not run`);
    assert.equal(
      result.status !== 0,
      shouldFail,
      `${name} had unexpected result:\n${diagnostics}`,
    );
    if (shouldFail) {
      assertRuntimeFloorDiagnostic(diagnostics, name);
    }
  }
});

test("runtime floor reports assignment aliases once and leaves wrappers unknown", async () => {
  const probes = [
    [
      "AbortSignal.any assignment alias",
      "let f; f = AbortSignal.any; f([]);",
      1,
    ],
    [
      "Object.groupBy assignment alias",
      "let group; group = Object.groupBy; group([], () => 1);",
      1,
    ],
    [
      "object-property wrapper",
      "const o = { s: AbortSignal }; o.s.any([]);",
      0,
    ],
    // Storing the API on a property defers the report to the eventual call
    // site, but CALLING it on the right-hand side stores only the return
    // value -- so the deferred tracking never sees the API. These must be
    // reported where they are invoked or they escape the gate entirely.
    [
      "AbortSignal.any invoked into a property",
      "const sink = {}; sink.value = AbortSignal.any([]);",
      1,
    ],
    [
      "Object.groupBy invoked into a property",
      "const sink = {}; sink.value = Object.groupBy([], () => 1);",
      1,
    ],
    [
      "AbortSignal.timeout invoked into a nested property",
      "const obj = { a: {} }; obj.a.b = AbortSignal.timeout(1);",
      1,
    ],
    [
      "optional-call invoked into a property",
      "const sink = {}; sink.value = AbortSignal?.any([]);",
      1,
    ],
    [
      "stored reference is still reported once at its call site",
      "const sink = {}; sink.value = AbortSignal.any; sink.value([]);",
      1,
    ],
  ];

  for (const [name, source, expected] of probes) {
    const result = await runEslint("src/lib/compat-contract.js", source);
    const diagnostics = `${result.stdout}${result.stderr}`;
    assert.equal(result.error, undefined, `${name} probe could not run`);
    assert.equal(
      runtimeFloorCount(diagnostics),
      expected,
      `${name}: ${diagnostics}`,
    );
  }
});

test("runtime floor models named, inline, and nested closure execution", async () => {
  const probes = [
    [
      "uncalled named replacement remains outside the outer flow",
      'let RuntimeRegExp = RegExp; function replace() { RuntimeRegExp = {}; } RuntimeRegExp.escape("x");',
      1,
    ],
    [
      "called named replacement affects later uses",
      'let RuntimeRegExp = RegExp; function replace() { RuntimeRegExp = {}; } replace(); RuntimeRegExp.escape("x");',
      0,
    ],
    [
      "called arrow replacement affects later uses",
      'let RuntimeRegExp = RegExp; const replace = () => { RuntimeRegExp = {}; }; replace(); RuntimeRegExp.escape("x");',
      0,
    ],
    [
      "called function-expression replacement affects later uses",
      'let RuntimeRegExp = RegExp; const replace = function () { RuntimeRegExp = {}; }; replace(); RuntimeRegExp.escape("x");',
      0,
    ],
    [
      "an IIFE replacement affects later uses",
      'let RuntimeRegExp = RegExp; (() => { RuntimeRegExp = {}; })(); RuntimeRegExp.escape("x");',
      0,
    ],
    [
      "a conditional call remains unknown",
      'let RuntimeRegExp = RegExp; function replace() { RuntimeRegExp = {}; } if (flag) replace(); RuntimeRegExp.escape("x");',
      0,
    ],
    [
      "a nested called replacement affects the outer use",
      'let RuntimeRegExp = RegExp; function outer() { function replace() { RuntimeRegExp = {}; } replace(); } outer(); RuntimeRegExp.escape("x");',
      0,
    ],
  ];

  for (const [name, source, expected] of probes) {
    const result = await runEslint("src/lib/compat-contract.js", source);
    const diagnostics = `${result.stdout}${result.stderr}`;
    assert.equal(result.error, undefined, `${name} probe could not run`);
    assert.equal(
      runtimeFloorCount(diagnostics),
      expected,
      `${name}: ${diagnostics}`,
    );
  }
});

test("runtime floor resolves computed keys at each use", async () => {
  const probes = [
    ["constant computed key", 'const key = "escape"; RegExp[key]("x");', 1],
    [
      "called key mutation",
      'let key = "escape"; function replace() { key = "other"; } replace(); RegExp[key]("x");',
      0,
    ],
    [
      "uncalled key mutation",
      'let key = "escape"; function replace() { key = "other"; } RegExp[key]("x");',
      1,
    ],
    [
      "conditional key mutation is unknown",
      'let key = "escape"; if (flag) key = "other"; RegExp[key]("x");',
      0,
    ],
    [
      "loop key mutation is unknown",
      'let key = "escape"; while (flag) key = "other"; RegExp[key]("x");',
      0,
    ],
    [
      "nested called key mutation",
      'let key = "escape"; function outer() { function replace() { key = "other"; } replace(); } outer(); RegExp[key]("x");',
      0,
    ],
  ];

  for (const [name, source, expected] of probes) {
    const result = await runEslint("src/lib/compat-contract.js", source);
    const diagnostics = `${result.stdout}${result.stderr}`;
    assert.equal(result.error, undefined, `${name} probe could not run`);
    assert.equal(
      runtimeFloorCount(diagnostics),
      expected,
      `${name}: ${diagnostics}`,
    );
  }
});

test("runtime floor follows globalThis and stable aliases for every tracked API", async () => {
  const sources = [
    "globalThis.Set.prototype.union.call(new Set(), new Set());",
    "globalThis.RegExp.escape('x');",
    "globalThis.Object.groupBy([], () => 1);",
    "globalThis.Promise.withResolvers();",
    "globalThis.Array.fromAsync([]);",
    "globalThis.AbortSignal.any([]);",
    "globalThis.AbortSignal.timeout(1);",
    "const runtime = globalThis; runtime.Set.prototype.union.call(new Set(), new Set());",
    "const { any, timeout } = AbortSignal; any([]); timeout(1);",
  ];

  for (const source of sources) {
    const result = await runEslint("src/lib/compat-contract.js", source);
    const diagnostics = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, `${source}\n${diagnostics}`);
    assertRuntimeFloorDiagnostic(diagnostics, source);
  }
});

test("runtime floor reports chained and destructured APIs exactly once", async () => {
  const probes = [
    ["Set.prototype.union.call(new Set(), new Set());", 1],
    ["const { union } = new Set(); union.call(new Set(), new Set());", 1],
    ['const { escape } = RegExp; escape("x");', 1],
    ['const escape = RegExp.escape; escape.call(RegExp, "x");', 1],
    [
      'const escape = RegExp.escape; const chained = escape; chained.call(RegExp, "x");',
      1,
    ],
    [
      'const escape = RegExp.escape; { const chained = escape; chained.call(RegExp, "x"); }',
      1,
    ],
    ['const method = "escape"; RegExp[method].call(RegExp, "x");', 1],
    [
      'const key = "escape"; const { [key]: escape } = RegExp; escape.call(RegExp, "x");',
      1,
    ],
  ];
  for (const [source, expected] of probes) {
    const result = await runEslint("src/lib/compat-contract.ts", source);
    const diagnostics = `${result.stdout}${result.stderr}`;
    assert.equal(runtimeFloorCount(diagnostics), expected, source);
  }
});

test("runtime floor invalidates mutated tracked properties and accepts proven restoration", async () => {
  const probes = [
    ['const R = RegExp; R.escape = custom; R.escape("x");', 0],
    [
      'const R = RegExp; R.escape = custom; R.escape = RegExp.escape; R.escape("x");',
      0,
    ],
    [
      "Set.prototype.union = custom; Set.prototype.union.call(new Set(), new Set());",
      0,
    ],
    [
      "const value = new Set(); value.union = custom; value.union(new Set());",
      0,
    ],
    [
      "Object.groupBy = custom; Object.groupBy = Object.groupBy; Object.groupBy([], () => 1);",
      0,
    ],
    [
      "Set.prototype.union = custom; Set.prototype.union = Set.prototype.union; Set.prototype.union.call(new Set(), new Set());",
      0,
    ],
    [
      "const value = new Set(); value.union = custom; value.union = Set.prototype.union; value.union(new Set());",
      1,
    ],
  ];
  for (const [source, expected] of probes) {
    const result = await runEslint("src/lib/compat-contract.ts", source);
    const diagnostics = `${result.stdout}${result.stderr}`;
    assert.equal(runtimeFloorCount(diagnostics), expected, source);
  }
});

test("runtime floor tracks mutations per object, closure, and restoration state", async () => {
  const probes = [
    [
      "uncalled property mutation",
      'let RuntimeRegExp = RegExp; function replace() { RuntimeRegExp.escape = custom; } RuntimeRegExp.escape("x");',
      1,
    ],
    [
      "called property mutation",
      'let RuntimeRegExp = RegExp; function replace() { RuntimeRegExp.escape = custom; } replace(); RuntimeRegExp.escape("x");',
      0,
    ],
    [
      "self-assignment preserves the replacement",
      'const RuntimeRegExp = RegExp; RuntimeRegExp.escape = custom; RuntimeRegExp.escape = RuntimeRegExp.escape; RuntimeRegExp.escape("x");',
      0,
    ],
    [
      "a captured built-in genuinely restores the property",
      'const original = RegExp.escape; const RuntimeRegExp = RegExp; RuntimeRegExp.escape = custom; RuntimeRegExp.escape = original; RuntimeRegExp.escape("x");',
      2,
    ],
    [
      "individual Set mutation does not affect another instance",
      "const value = new Set(); value.union = custom; new Set().union(new Set());",
      1,
    ],
    [
      "Set prototype mutation affects all instances",
      "Set.prototype.union = custom; new Set().union(new Set());",
      0,
    ],
    [
      "destructuring captures the property state at access",
      'const RuntimeRegExp = RegExp; RuntimeRegExp.escape = custom; const { escape } = RuntimeRegExp; escape("x");',
      0,
    ],
    [
      "destructuring captured before mutation remains the built-in",
      'const RuntimeRegExp = RegExp; const { escape } = RuntimeRegExp; RuntimeRegExp.escape = custom; escape("x");',
      1,
    ],
    [
      "computed destructuring captures the property state at access",
      'const key = "escape"; const RuntimeRegExp = RegExp; RuntimeRegExp[key] = custom; const { [key]: escape } = RuntimeRegExp; escape("x");',
      0,
    ],
  ];

  for (const [name, source, expected] of probes) {
    const result = await runEslint("src/lib/compat-contract.js", source);
    const diagnostics = `${result.stdout}${result.stderr}`;
    assert.equal(result.error, undefined, `${name} probe could not run`);
    assert.equal(
      runtimeFloorCount(diagnostics),
      expected,
      `${name}: ${diagnostics}`,
    );
  }
});

test("runtime floor indexes forward scoped TypeScript aliases conservatively", async () => {
  const probes = [
    [
      "forward alias",
      "const value = ({} as RuntimeSet); value.union(); type RuntimeSet = Set<number>;",
      1,
    ],
    [
      "forward alias chain",
      "const value = ({} as First); value.union(); type First = Second; type Second = Set<number>;",
      1,
    ],
    [
      "nested same-named alias shadows the outer alias",
      "type RuntimeSet = Set<number>; { type RuntimeSet = Map<number>; const value = ({} as RuntimeSet); value.union(); }",
      0,
    ],
    [
      "recursive alias remains unknown",
      "type First = Second; type Second = First; const value = ({} as First); value.union();",
      0,
    ],
    [
      "Map alias remains unknown",
      "type RuntimeSet = Map<number, number>; const value = ({} as RuntimeSet); value.union();",
      0,
    ],
  ];

  for (const [name, source, expected] of probes) {
    const result = await runEslint("src/lib/compat-contract.ts", source);
    const diagnostics = `${result.stdout}${result.stderr}`;
    assert.equal(result.error, undefined, `${name} probe could not run`);
    assert.equal(
      runtimeFloorCount(diagnostics),
      expected,
      `${name}: ${diagnostics}`,
    );
  }
});

test("runtime floor ignores shadowed tracked globals in nested scopes", async () => {
  const source = `
    const value = { union() {} };
    function local(Set, RegExp, Object, Promise, Array, AbortSignal) {
      new Set().union();
      RegExp.escape("x");
      Object.groupBy([], () => 1);
      Promise.withResolvers();
      Array.fromAsync([]);
      AbortSignal.any([]);
      AbortSignal.timeout(1);
      value.union();
    }
  `;
  const result = await runEslint("src/lib/compat-contract.js", source);
  assert.equal(
    result.status,
    0,
    `shadowed nested implementations were rejected:\n${result.stdout}${result.stderr}`,
  );
});

test("compatibility plugin reports a recognized unsupported ES API", async () => {
  const result = runEslintCli(
    ["--stdin", "--stdin-filename", "src/lib/compat-contract.js"],
    "Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n",
  );
  const diagnostics = `${result.stdout}${result.stderr}`;

  assert.equal(
    result.error,
    undefined,
    "Atomics.waitAsync probe could not run",
  );
  assert.notEqual(
    result.status,
    0,
    `Atomics.waitAsync unexpectedly passed the browser compatibility gate:\n${diagnostics}`,
  );
  assert.match(
    diagnostics,
    /compat\/compat/,
    `Atomics.waitAsync was not rejected by eslint-plugin-compat:\n${diagnostics}`,
  );
});

test("compatibility gate permits a baseline-supported ES API", async () => {
  const result = runEslintCli(
    ["--stdin", "--stdin-filename", "src/lib/compat-contract.js"],
    "Array.from([]);\n",
  );

  assert.equal(
    result.status,
    0,
    `Array.from unexpectedly failed the browser compatibility gate:\n${result.stdout}${result.stderr}`,
  );
});

test("known-gap restrictions do not ban unrelated union methods", async () => {
  const result = await runEslint(
    "src/lib/compat-contract.js",
    "const value = { union: () => 1 };\nvalue.union();\nnew Map().union(new Map());\n",
  );

  assert.equal(
    result.status,
    0,
    `unrelated union methods unexpectedly failed the compatibility gate:\n${result.stdout}${result.stderr}`,
  );
});

test("JSON-LD Svelte files receive the compatibility rules", async () => {
  const files = [
    "src/lib/components/SeoHead.svelte",
    "src/routes/[username]/[vanity]/+page.svelte",
    "src/routes/article/[id]/+page.svelte",
  ];

  for (const file of files) {
    const config = await eslint.calculateConfigForFile(join(packageRoot, file));
    assert.ok(config, `could not calculate ESLint config for ${file}`);
    const plugins = config.plugins ?? {};
    assert.ok(
      Object.hasOwn(plugins, "compat") ||
        Object.keys(plugins).some((plugin) => plugin.startsWith("compat:")),
      `${file} is missing the compat plugin`,
    );
    assert.ok(
      config.rules["compat/compat"],
      `${file} is missing the compat/compat rule`,
    );
    assert.ok(
      config.rules["free2z-runtime/compatibility-floor"],
      `${file} is missing the generalized runtime-floor rule`,
    );
  }
});

test("server and test scopes disable both browser runtime rules", async () => {
  const source =
    "AbortSignal.any([]);\nAtomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n";
  const probes = [
    ["src/routes/compat-client.js", false],
    ["src/lib/server/compat-probe.js", true],
    ["src/routes/compat/+page.server.ts", true],
    ["src/routes/compat/+server.ts", true],
    ["vite.config.ts", true],
    ["playwright.config.ts", true],
    ["tests/compat-probe.mjs", true],
  ];

  for (const [filename, shouldPass] of probes) {
    const result = await runEslint(filename, source);
    const diagnostics = `${result.stdout}${result.stderr}`;
    assert.equal(
      result.status === 0,
      shouldPass,
      `${filename} had unexpected result:\n${diagnostics}`,
    );
    if (!shouldPass) {
      assert.match(diagnostics, /free2z-runtime\/compatibility-floor/);
      assert.match(diagnostics, /compat\/compat/);
    }
  }
});

test("API generation syncs and normalizes only the generated Stripe surface", async () => {
  const packageJson = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["generate:api"],
    "svelte-kit sync && orval",
    "generate:api must prepare SvelteKit before running Orval",
  );

  const orvalConfig = readFileSync(
    join(packageRoot, "orval.config.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    orvalConfig,
    /\bprettier\s*:/,
    "legacy Orval output must stay decoupled from repository-wide Prettier",
  );
  assert.match(
    orvalConfig,
    /prettier --write --ignore-path \.prettierignore-orval src\/lib\/api\/stripe\/stripe\.ts/,
    "Stripe generation must remove Orval's trailing whitespace deterministically",
  );
  assert.match(
    orvalConfig,
    /injectGeneratedDirsAndFiles:\s*false/,
    "the targeted formatter must not receive every generated path",
  );
  const generatedStripe = readFileSync(
    join(packageRoot, "src/lib/api/stripe/stripe.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    generatedStripe,
    /[ \t]+$/m,
    "the committed Stripe client must contain no trailing whitespace",
  );
});

test("Svelte JavaScript, TypeScript, and JSON-LD snippets are linted by both gates", async () => {
  const snippets = [
    [
      "src/routes/compat-js/+page.svelte",
      `<script>\n  RegExp.escape("x");\n  Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n</script>\n`,
    ],
    [
      "src/routes/compat-ts/+page.svelte",
      `<script lang="ts">\n  const values: Set<number> = new Set();\n  values.union(new Set());\n  Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n</script>\n`,
    ],
    [
      "src/routes/compat-json-ld/+page.svelte",
      `<script>\n  Object.groupBy([], () => 1);\n  Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n</script>\n<svelte:head><script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage"}</script></svelte:head>\n`,
    ],
  ];
  for (const [filename, source] of snippets) {
    const result = await runEslint(filename, source);
    const diagnostics = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, filename);
    assert.match(diagnostics, /free2z-runtime\/compatibility-floor/, filename);
    assert.match(diagnostics, /compat\/compat/, filename);
  }
});
