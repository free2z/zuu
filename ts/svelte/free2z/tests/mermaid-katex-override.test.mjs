// mermaid declares "katex": "^0.16.x" in every published release (10.9.8, and
// 12.1.0 still pins ^0.16.47), and katex < 0.18.2 carries GHSA-238p-pmpm-9mq7
// (prototype pollution bypassing `trust` restrictions). package.json therefore
// forces mermaid's katex onto the app's own KaTeX version with a scoped `overrides`
// entry instead of baselining the advisory -- the same shape as the
// realtimekit/uuid override (realtimekit-uuid-override.test.mjs).
//
// This is reachable, which is why it is fixed rather than excused: any zPage
// with a ```mermaid block whose label contains `$$...$$` makes MarkdownContent's
// `import("mermaid")` (mermaid.core.mjs) dynamically `import("katex")` and call
// `renderToString` on author-controlled text in the reader's browser.
//
// The override is only safe while mermaid uses nothing later KaTeX versions changed
// (0.17: the internal `__defineFunction` shape; 0.18: CSS class prefixes). This
// test pins both halves against the INSTALLED packages:
//   1. the katex mermaid's ESM entry actually resolves is >= 0.18.2 and is the
//      same single copy the app renders markdown math with;
//   2. every katex member mermaid's ESM graph reaches is `renderToString`, and
//      it renders with exactly the options mermaid passes, under both the
//      `import` and `require` conditions.
// The bundle scan fails CLOSED: a reference to the "katex" specifier it does
// not recognise is an error, so a mermaid bump that starts using katex
// differently cannot slip past a parser that quietly matched nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mermaidRoot = join(packageRoot, "node_modules/mermaid");
const mermaidPackage = JSON.parse(
  readFileSync(join(mermaidRoot, "package.json"), "utf8"),
);
// The entry Vite bundles for MarkdownContent's `import("mermaid")`.
const mermaidEntry = join(
  mermaidRoot,
  mermaidPackage.exports["."].import.default ??
    mermaidPackage.exports["."].import,
);
const mermaidRequire = createRequire(mermaidEntry);
const katexPackageJsonPath = mermaidRequire.resolve("katex/package.json");
const katexRoot = dirname(katexPackageJsonPath);
const katexPackage = JSON.parse(readFileSync(katexPackageJsonPath, "utf8"));

const IDENT = "[A-Za-z_$][\\w$]*";
const KATEX_SPECIFIER = /["']katex["']/g;
const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

function atLeast(version, floor) {
  const parse = (v) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    assert.ok(match, `unparseable version ${v}`);
    return match.slice(1, 4).map(Number);
  };
  const a = parse(version);
  const b = parse(floor);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

// Every file reachable from mermaid's ESM entry through relative static and
// dynamic imports -- i.e. what Vite can put in the browser bundle.
function esmGraph(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const [, specifier] of source.matchAll(RELATIVE_IMPORT)) {
      queue.push(resolve(dirname(file), specifier));
    }
  }
  return [...seen];
}

// Returns the katex members one file uses, or null when it never names the
// "katex" specifier. Throws on any reference it cannot account for.
function katexMembersUsedBy(file) {
  const source = readFileSync(file, "utf8");
  const specifierCount = (source.match(KATEX_SPECIFIER) ?? []).length;
  if (specifierCount === 0) return null;

  const dynamicDefault = new RegExp(
    `\\{\\s*default\\s*:\\s*(${IDENT})\\s*\\}\\s*=\\s*await\\s+import\\(\\s*["']katex["']\\s*\\)`,
    "g",
  );
  const locals = [...source.matchAll(dynamicDefault)].map(([, local]) => local);
  assert.equal(
    locals.length,
    specifierCount,
    `${file} references "katex" ${specifierCount} time(s) but only ` +
      `${locals.length} match the recognised \`const { default: x } = await ` +
      `import("katex")\` shape -- review how mermaid now uses katex before ` +
      `trusting the override`,
  );

  const members = new Set();
  for (const local of new Set(locals)) {
    const escaped = local.replace(/\$/g, "\\$");
    for (const [, member] of source.matchAll(
      new RegExp(`(?<![\\w$."'-])${escaped}\\s*\\.\\s*(${IDENT})`, "g"),
    )) {
      members.add(member);
    }
    // The binding must not escape (passed to a function, re-exported...),
    // or the member list above is not the whole story.
    const bare = [
      ...source.matchAll(
        new RegExp(`(?<![\\w$."'-])${escaped}(?![\\w$-])(?!\\s*\\.)`, "g"),
      ),
    ];
    const declarations = [
      ...source.matchAll(new RegExp(`default\\s*:\\s*${escaped}\\b`, "g")),
    ];
    assert.equal(
      bare.length,
      declarations.length,
      `${file}: the katex binding \`${local}\` is used other than as ` +
        `\`${local}.member\`; extend this test before trusting the override`,
    );
  }
  return members;
}

test("mermaid's katex resolves to the patched, single app copy (GHSA-238p-pmpm-9mq7)", () => {
  assert.equal(katexPackage.name, "katex");
  assert.ok(
    atLeast(katexPackage.version, "0.18.2"),
    `mermaid resolves katex ${katexPackage.version} from ${katexRoot}; ` +
      `GHSA-238p-pmpm-9mq7 is fixed in 0.18.2 -- is the package.json ` +
      `overrides.mermaid.katex entry still there?`,
  );
  assert.equal(
    katexRoot,
    join(packageRoot, "node_modules/katex"),
    "mermaid should share the app's katex (one copy, one stylesheet); if the " +
      "top-level katex moved past the override's range, move the override too",
  );
});

test("mermaid's ESM graph uses only katex.renderToString", () => {
  const graph = esmGraph(mermaidEntry);
  assert.ok(
    graph.length > 10,
    `followed only ${graph.length} file(s) from ${mermaidEntry}; the import ` +
      "scanner no longer understands mermaid's dist layout",
  );
  const used = new Set();
  let users = 0;
  for (const file of graph) {
    const members = katexMembersUsedBy(file);
    if (members === null) continue;
    users += 1;
    for (const member of members) used.add(member);
  }
  assert.ok(
    users >= 1,
    "no file in mermaid's ESM graph imports katex any more -- the override " +
      "may be dead weight; re-check `npm audit` and drop it if so",
  );
  assert.deepEqual([...used].sort(), ["renderToString"]);
});

// mermaid's renderKatexUnsanitized: displayMode, throwOnError, and "mathml"
// where the browser has MathMLElement, "htmlAndMathml" otherwise.
for (const output of ["mathml", "htmlAndMathml"]) {
  for (const condition of ["import", "require"]) {
    test(`katex.renderToString works as mermaid calls it (${condition}, output=${output})`, async () => {
      const katex =
        condition === "require"
          ? mermaidRequire("katex")
          : (
              await import(
                pathToFileURL(
                  join(katexRoot, katexPackage.exports["."].import.default),
                ).href
              )
            ).default;
      assert.equal(typeof katex.renderToString, "function");

      const html = katex.renderToString("x^2 + \\frac{a}{b}", {
        throwOnError: true,
        displayMode: true,
        output,
      });
      assert.match(html, /<math\b/);
      assert.match(html, /<mfrac>/);
      if (output === "htmlAndMathml") assert.match(html, /katex-html/);

      // mermaid relies on throwOnError to fall back to its error rendering.
      assert.throws(
        () =>
          katex.renderToString("\\frac{", {
            throwOnError: true,
            displayMode: true,
            output,
          }),
        (error) => error instanceof katex.ParseError,
      );
    });
  }
}
