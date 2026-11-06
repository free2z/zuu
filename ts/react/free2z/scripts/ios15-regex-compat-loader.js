// Preserve upstream autolink boundaries without regex lookbehind, which iOS 15
// cannot parse. Every replacement is exact and unique; dependency source drift
// requires another audit rather than silently dropping a boundary condition.
const rewrites = [
  [
    String.raw`/(?<![\da-z])(https?:\/\/|www(?=\.))`,
    String.raw`/(https?:\/\/|www(?=\.))`,
  ],
  [String.raw`/(?<![\w+\-.@])xmpp:`, String.raw`/xmpp:`],
  [String.raw`/(?<![\w+\-.@])mailto:`, String.raw`/mailto:`],
  [String.raw`/(?<![\w+\-.]|(?:^|[^\d@A-Za-z])(?:mailto|xmpp):)`, "/"],
  [
    "function findUrl(_, protocol, domain, path, match) {",
    String.raw`function findUrl(_, protocol, domain, path, match) {
  if (/[\da-z]$/i.test(match.input.slice(0, match.index))) return false`,
  ],
  [
    "function findXmpp(matchValue, atext, label, resource, match) {",
    String.raw`function findXmpp(matchValue, atext, label, resource, match) {
  if (/[\w+\-.@]$/.test(match.input.slice(0, match.index))) return false`,
  ],
  [
    "function findMailto(_, atext, label) {",
    String.raw`function findMailto(_, atext, label, match) {
  if (/[\w+\-.@]$/.test(match.input.slice(0, match.index))) return false`,
  ],
  [
    "function findEmail(_, atext, label) {",
    String.raw`function findEmail(_, atext, label, match) {
  if (/[\w+\-.]$|(?:^|[^\d@A-Za-z])(?:mailto|xmpp):$/.test(match.input.slice(0, match.index))) return false`,
  ],
];

module.exports = function ios15RegexCompatLoader(source) {
  for (const [before, after] of rewrites) {
    const occurrences = source.split(before).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `Expected one audited mdast autolink source fragment; found ${occurrences}. ` +
          "Re-audit the dependency before changing this compatibility rewrite."
      );
    }
    source = source.replace(before, after);
  }
  return source;
};
