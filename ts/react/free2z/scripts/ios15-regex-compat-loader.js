// iOS 15 cannot parse lookbehind. Consume an allowed boundary instead and
// preserve that text beside the upstream callback's result. Matching boundaries
// before the candidate avoids rescanning long rejected email/URL suffixes.
const rewrites = [
  [
    String.raw`/(?<![\da-z])(https?:\/\/|www(?=\.))`,
    String.raw`/(^|[^\da-z])(https?:\/\/|www(?=\.))`,
  ],
  [String.raw`/(?<![\w+\-.@])xmpp:`, String.raw`/(^|[^\w+\-.@])xmpp:`],
  [String.raw`/(?<![\w+\-.@])mailto:`, String.raw`/(^|[^\w+\-.@])mailto:`],
  [
    String.raw`/(?<![\w+\-.]|(?:^|[^\d@A-Za-z])(?:mailto|xmpp):)`,
    String.raw`/(^|[^\w+\-.])`,
  ],
  ["        findUrl\n", "        withAutolinkBoundary(findUrl)\n"],
  ["        findXmpp\n", "        withAutolinkBoundary(findXmpp)\n"],
  ["/g, findMailto]", "/g, withAutolinkBoundary(findMailto)]"],
  ["        findEmail\n", "        withAutolinkBoundary(findEmail, true)\n"],
];
const callbackSignatures = [
  "function findUrl(_, protocol, domain, path, match) {",
  "function findXmpp(matchValue, atext, label, resource, match) {",
  "function findMailto(_, atext, label) {",
  "function findEmail(_, atext, label) {",
];
const adapter = String.raw`
function withAutolinkBoundary(replace, email = false) {
  return function(value, prefix, ...parts) {
    const match = parts.pop()
    const actual = {...match, index: match.index + prefix.length}
    if (email && /(?:^|[^\d@A-Za-z])(?:mailto|xmpp):$/.test(actual.input.slice(0, actual.index))) return false
    const result = replace(value.slice(prefix.length), ...parts, actual)
    if (result === false || !prefix) return result
    return [{type: 'text', value: prefix}, ...(Array.isArray(result) ? result : [result])]
  }
}
`;

module.exports = function ios15RegexCompatLoader(source) {
  for (const fragment of [
    ...rewrites.map(([before]) => before),
    ...callbackSignatures,
  ]) {
    const occurrences = source.split(fragment).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `Expected one audited mdast autolink source fragment; found ${occurrences}. ` +
          "Re-audit the dependency before changing this compatibility rewrite."
      );
    }
  }
  for (const [before, after] of rewrites)
    source = source.replace(before, after);
  return source + adapter;
};
