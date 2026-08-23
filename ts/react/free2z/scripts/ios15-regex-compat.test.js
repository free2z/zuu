const assert = require("node:assert/strict");
const loader = require("./ios15-regex-compat-loader");
const { findLookbehindRegexLiterals } = require("./check-ios15-bundle");

const fixture = `const email = ${loader.unsupportedEmailPattern}\nif (${loader.existingBoundaryGuard}) return false`;
const rewritten = loader(fixture);

function compile(pattern) {
  return Function(`return ${pattern}`)();
}

function guardedMatches(pattern, input) {
  return [...input.matchAll(pattern)]
    .filter((match) => {
      const code = input.charCodeAt(match.index - 1);
      const previous = String.fromCharCode(code);

      return (
        (match.index === 0 || /[\s\p{P}\p{S}]/u.test(previous)) && code !== 47
      );
    })
    .map((match) => match[0]);
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
for (const input of [
  "person@example.com",
  "Contact person@example.com today",
  "(person@example.com)",
  "$person@example.com",
  "/person@example.com",
  "éperson@example.com",
  "🙂person@example.com",
]) {
  assert.deepEqual(
    guardedMatches(compatible, input),
    guardedMatches(unsupported, input),
    input
  );
}

assert.throws(
  () => loader(`const email = ${loader.unsupportedEmailPattern}`),
  /found 1 lookbehind\(s\) and 0 guard\(s\)/
);
assert.throws(
  () => loader(`${fixture}\n${fixture}`),
  /found 2 lookbehind\(s\) and 2 guard\(s\)/
);

console.log("iOS 15 regex compatibility self-test passed.");
