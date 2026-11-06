const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const loader = require("./ios15-regex-compat-loader");
const {
  checkBundle,
  findLookbehindRegexLiterals,
  javascriptFiles,
} = require("./check-ios15-bundle");

const { pathToFileURL } = require("node:url");
const fixture = "const positive = /(?<=prefix)value/;";

function runScanner(...args) {
  return childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, "check-ios15-bundle.js"), ...args],
    { encoding: "utf8" }
  );
}

assert.deepEqual(findLookbehindRegexLiterals(fixture), ["<source>:1:18"]);
assert.deepEqual(
  findLookbehindRegexLiterals(
    'const text = "/(?<=not executable)/"; const named = /(?<name>x)/'
  ),
  []
);
assert.deepEqual(
  findLookbehindRegexLiterals("const negative = /(?<!prefix)value/"),
  ["<source>:1:18"]
);

async function verifyUpstreamAutolinks() {
  const entry = require.resolve("mdast-util-gfm-autolink-literal");
  const sourcePath = path.join(path.dirname(entry), "lib/index.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.equal(findLookbehindRegexLiterals(source).length, 4);
  const rewritten = loader(source);
  assert.deepEqual(findLookbehindRegexLiterals(rewritten), []);
  assert.throws(() => loader(source + "\n" + source), /found 2/);
  assert.throws(
    () =>
      loader(source.replace("function findEmail(", "function changedEmail(")),
    /found 0/
  );

  // Load the rewritten dependency itself, with its actual installed imports.
  // A data URL avoids modifying node_modules or resolving a test-only mock.
  const executable = rewritten.replace(
    /^(import .+ from )'([^']+)'/gm,
    (_, prefix, specifier) =>
      prefix +
      JSON.stringify(
        pathToFileURL(
          require.resolve(specifier, { paths: [path.dirname(sourcePath)] })
        ).href
      )
  );
  const upstream = await import(pathToFileURL(sourcePath).href);
  const compatible = await import(
    "data:text/javascript;base64," + Buffer.from(executable).toString("base64")
  );
  const originalTransform =
    upstream.gfmAutolinkLiteralFromMarkdown().transforms[0];
  const compatibleTransform =
    compatible.gfmAutolinkLiteralFromMarkdown().transforms[0];
  function transformed(transform, input) {
    const tree = {
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "text", value: input }] },
      ],
    };
    transform(tree);
    return tree;
  }
  const prefixes = [
    "",
    " ",
    "\n",
    "\r\n",
    "(",
    "$",
    "/",
    "x",
    "0",
    "é",
    "🙂",
    ".",
    "-",
    "+",
    "@",
    "mailto:",
    "xmpp:",
    "xmailto:",
    "@mailto:",
    "éxmpp:",
    "long-prefix-amailto:",
    "long-prefix-.mailto:",
    "long-prefix-axmpp:",
    "long-prefix-.xmpp:",
  ];
  const values = [
    "person@example.com",
    "first+last@example.com",
    "first.last@example.com",
    "https://example.com",
    "HTTP://example.com/a",
    "www.example.com",
    "mailto:person@example.com",
    "xmpp:person@example.com",
    "xmpp:person@example.com/room",
    "xmpp:person@example.com/a.b",
    "a@b.c",
    "person@example.com-",
    "person@example.c0",
  ];
  const suffixes = [
    "",
    " ",
    ")",
    ".",
    "/",
    "@",
    "@tail.test",
    "\nnext@example.com",
    " http://example.org",
  ];
  for (const prefix of prefixes) {
    for (const value of values) {
      for (const suffix of suffixes) {
        const input = prefix + value + suffix;
        assert.deepEqual(
          transformed(compatibleTransform, input),
          transformed(originalTransform, input),
          input
        );
      }
    }
  }
  // Rejected long candidates must not be retried at every character. The
  // original lookbehind rejects their boundary before consuming the suffix.
  for (const input of [
    ".mailto:" + "a".repeat(99_980) + "@b.co",
    "x" + "https://example.com/".repeat(5_000),
    "x" + "xmpp:person@example.com/".repeat(4_000),
    " a@b.co ".repeat(12_000),
  ]) {
    const expected = transformed(originalTransform, input);
    const started = performance.now();
    const actual = transformed(compatibleTransform, input);
    assert.ok(
      performance.now() - started < 500,
      "autolink boundary rejection exceeded 500ms"
    );
    assert.deepEqual(actual, expected);
  }
  for (const [input, urls] of [
    ["person@example.com", ["mailto:person@example.com"]],
    ["https://example.com", ["https://example.com"]],
    ["mailto:person@example.com", ["mailto:person@example.com"]],
    ["xmpp:person@example.com/room", ["xmpp:person@example.com/room"]],
    ["xhttps://example.com", []],
  ]) {
    for (const transform of [originalTransform, compatibleTransform]) {
      assert.deepEqual(
        transformed(transform, input)
          .children[0].children.filter((node) => node.type === "link")
          .map((node) => node.url),
        urls,
        input
      );
    }
  }
}

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "free2z-ios15-regex-")
);

try {
  const bundleDirectory = path.join(temporaryRoot, "bundles");
  fs.mkdirSync(bundleDirectory);
  fs.writeFileSync(
    path.join(bundleDirectory, "00-positive.js"),
    "const positive = /(?<=prefix)value/;\n"
  );
  fs.writeFileSync(
    path.join(bundleDirectory, "50-safe.js"),
    'const text = "/(?<=not executable)/"; const named = /(?<name>x)/;\n'
  );
  fs.writeFileSync(
    path.join(bundleDirectory, "99-negative.js"),
    "const negative = /(?<!prefix)value/;\n"
  );
  fs.writeFileSync(
    path.join(bundleDirectory, "ignored.txt"),
    "const ignored = /(?<=prefix)value/;\n"
  );

  assert.deepEqual(
    javascriptFiles(bundleDirectory)
      .map((filename) => path.basename(filename))
      .sort(),
    ["00-positive.js", "50-safe.js", "99-negative.js"]
  );
  assert.deepEqual(checkBundle(bundleDirectory).sort(), [
    `${path.join(bundleDirectory, "00-positive.js")}:1:18`,
    `${path.join(bundleDirectory, "99-negative.js")}:1:18`,
  ]);

  const failingScan = runScanner(bundleDirectory);
  assert.equal(failingScan.status, 1, failingScan.stderr);
  assert.match(failingScan.stderr, /00-positive\.js:1:18/);
  assert.match(failingScan.stderr, /99-negative\.js:1:18/);

  const cleanDirectory = path.join(temporaryRoot, "clean");
  fs.mkdirSync(cleanDirectory);
  fs.writeFileSync(
    path.join(cleanDirectory, "main.js"),
    'const text = "/(?<=not executable)/"; const ratio = total / count;\n'
  );
  assert.deepEqual(checkBundle(cleanDirectory), []);

  const cleanScan = runScanner(cleanDirectory);
  assert.equal(cleanScan.status, 0, cleanScan.stderr);
  assert.match(cleanScan.stdout, /passed \(1 bundles scanned\)/);

  const missingDirectory = path.join(temporaryRoot, "missing");
  assert.throws(
    () => javascriptFiles(missingDirectory),
    /Missing production bundle directory/
  );
  const missingScan = runScanner(missingDirectory);
  assert.equal(missingScan.status, 1);
  assert.match(missingScan.stderr, /Missing production bundle directory/);

  const emptyDirectory = path.join(temporaryRoot, "empty");
  fs.mkdirSync(emptyDirectory);
  assert.throws(
    () => javascriptFiles(emptyDirectory),
    /No JavaScript bundles found/
  );
  const emptyScan = runScanner(emptyDirectory);
  assert.equal(emptyScan.status, 1);
  assert.match(emptyScan.stderr, /No JavaScript bundles found/);
} finally {
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
}

const packageJson = require(path.join(__dirname, "..", "package.json"));
assert.equal(
  packageJson.scripts.prebuild,
  "npm run test:ios15-regex-compat",
  "prebuild must run the iOS 15 compatibility self-test"
);
assert.equal(
  packageJson.scripts.build,
  "react-app-rewired build && node scripts/check-ios15-bundle.js",
  "production builds must scan every emitted JavaScript bundle"
);
assert.match(
  packageJson.scripts.test,
  /^npm run test:ios15-regex-compat && /,
  "the standard test command must enforce the production build hook contract"
);

verifyUpstreamAutolinks()
  .then(() => {
    console.log(
      "iOS 15 regex compatibility self-test and upstream autolink oracle passed."
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
