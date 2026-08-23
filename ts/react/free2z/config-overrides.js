const path = require("path");

const ios15RegexCompatLoader = path.resolve(
  __dirname,
  "scripts/ios15-regex-compat-loader.js"
);
const gfmAutolinkEntry = require.resolve("mdast-util-gfm-autolink-literal");
const gfmAutolinkSource = path.join(
  path.dirname(gfmAutolinkEntry),
  "lib/index.js"
);

module.exports = function override(config, env) {
  // New config, e.g. config.plugins.push...

  console.log(config.resolve);
  config.resolve.fallback = {
    // assert: require.resolve('assert'),
    // crypto: require.resolve('crypto-browserify'),
    // http: require.resolve('stream-http'),
    // https: require.resolve('https-browserify'),
    // os: require.resolve('os-browserify/browser'),
    // stream: require.resolve('stream-browserify'),
    // path: require.resolve('path-browserify'),
    // buffer: require.resolve("buffer/"),
    // zlib: require.resolve("browserify-zlib"),
    path: false,
    fs: false,
    net: false,
    tls: false,
    dns: false,
    process: false,
  };

  // mdast-util-gfm-autolink-literal@2 emits a lookbehind regex literal.
  // Safari on iOS 15 rejects the whole bundle while parsing it, before the
  // app can render. Its existing `previous(match, true)` guard performs the
  // same boundary check, so remove only that redundant syntax at build time.
  // The loader fails closed if the upstream source changes shape.
  config.module.rules.push({
    test: /\.js$/,
    include: [gfmAutolinkSource],
    enforce: "pre",
    use: [{ loader: ios15RegexCompatLoader }],
  });

  return config;
};
