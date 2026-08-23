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

const fixture = `const email = ${loader.unsupportedEmailPattern}\nif (${loader.existingBoundaryGuard}) return false`;
const rewritten = loader(fixture);

function compile(pattern) {
  return Function(`return ${pattern}`)();
}

function guardedMatches(pattern, input) {
  const matches = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(input);

  while (match) {
    const code = input.charCodeAt(match.index - 1);
    const previous = String.fromCharCode(code);
    const accepted =
      (match.index === 0 || /[\s\p{P}\p{S}]/u.test(previous)) && code !== 47;

    if (accepted) {
      matches.push(match[0]);
    } else {
      // mdast-util-find-and-replace retries one character after a rejected
      // match, so a later valid candidate inside that match is not skipped.
      pattern.lastIndex = match.index + 1;
    }

    match = pattern.exec(input);
  }

  return matches;
}

function runScanner(...args) {
  return childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, "check-ios15-bundle.js"), ...args],
    { encoding: "utf8" }
  );
}

assert.equal(
  rewritten,
  `const email = ${loader.compatibleEmailPattern}\nif (${loader.existingBoundaryGuard}) return false`
);
assert.deepEqual(findLookbehindRegexLiterals(fixture), ["<source>:1:15"]);
assert.deepEqual(findLookbehindRegexLiterals(rewritten), []);
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

const unsupported = compile(loader.unsupportedEmailPattern);
const compatible = compile(loader.compatibleEmailPattern);
for (const [input, expected] of [
  ["person@example.com", ["person@example.com"]],
  ["Contact person@example.com today", ["person@example.com"]],
  ["(person@example.com)", ["person@example.com"]],
  ["$person@example.com", ["person@example.com"]],
  ["first+last@example.com", ["first+last@example.com"]],
  ["first.last@example.com", ["first.last@example.com"]],
  ["first-last@example.com", ["first-last@example.com"]],
  ["/person@example.com", []],
  ["éperson@example.com", []],
  ["🙂person@example.com", []],
  ["é.foo@example.com", ["foo@example.com"]],
  ["é-person@example.com", ["person@example.com"]],
  ["é+person@example.com", ["person@example.com"]],
]) {
  assert.deepEqual(guardedMatches(unsupported, input), expected, input);
  assert.deepEqual(guardedMatches(compatible, input), expected, input);
}

assert.throws(
  () => loader(`const email = ${loader.unsupportedEmailPattern}`),
  /found 1 lookbehind\(s\) and 0 guard\(s\)/
);
assert.throws(
  () => loader(`${fixture}\n${fixture}`),
  /found 2 lookbehind\(s\) and 2 guard\(s\)/
);

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

console.log("iOS 15 regex compatibility self-test passed.");
