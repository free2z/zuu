const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

function findLookbehindRegexLiterals(source, filename = "<source>") {
  const failures = [];
  const tokens = acorn.tokenizer(source, {
    ecmaVersion: "latest",
    locations: true,
  });

  for (const token of tokens) {
    if (
      token.type.label === "regexp" &&
      (token.value.pattern.includes("(?<=") ||
        token.value.pattern.includes("(?<!"))
    ) {
      failures.push(
        `${filename}:${token.loc.start.line}:${token.loc.start.column + 1}`
      );
    }
  }

  return failures;
}

function javascriptFiles(directory) {
  if (!fs.existsSync(directory)) {
    throw new Error(`Missing production bundle directory: ${directory}`);
  }

  const files = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(directory, name));

  if (files.length === 0) {
    throw new Error(`No JavaScript bundles found in: ${directory}`);
  }

  return files;
}

function checkBundle(directory) {
  return javascriptFiles(directory).flatMap((filename) =>
    findLookbehindRegexLiterals(fs.readFileSync(filename, "utf8"), filename)
  );
}

if (require.main === module) {
  const bundleDirectory = path.resolve(
    process.argv[2] || path.join("build", "static", "js")
  );
  const failures = checkBundle(bundleDirectory);

  if (failures.length > 0) {
    console.error(
      "iOS 15-incompatible lookbehind regex literals found:\n" +
        failures.map((failure) => `- ${failure}`).join("\n")
    );
    process.exitCode = 1;
  } else {
    console.log(
      `iOS 15 regex compatibility passed (${
        javascriptFiles(bundleDirectory).length
      } bundles scanned).`
    );
  }
}

module.exports = { checkBundle, findLookbehindRegexLiterals, javascriptFiles };
