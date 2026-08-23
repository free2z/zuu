const unsupportedEmailPattern = String.raw`/(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu`;
const compatibleEmailPattern = String.raw`/([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu`;
const existingBoundaryGuard = "!previous(match, true)";

module.exports = function ios15RegexCompatLoader(source) {
  const occurrences = source.split(unsupportedEmailPattern).length - 1;
  const guardOccurrences = source.split(existingBoundaryGuard).length - 1;

  if (occurrences !== 1 || guardOccurrences !== 1) {
    throw new Error(
      "Expected one mdast GFM email lookbehind and its existing boundary " +
        `guard; found ${occurrences} lookbehind(s) and ${guardOccurrences} guard(s). ` +
        "Re-audit the dependency before changing this compatibility rewrite."
    );
  }

  return source.replace(unsupportedEmailPattern, compatibleEmailPattern);
};

module.exports.compatibleEmailPattern = compatibleEmailPattern;
module.exports.existingBoundaryGuard = existingBoundaryGuard;
module.exports.unsupportedEmailPattern = unsupportedEmailPattern;
