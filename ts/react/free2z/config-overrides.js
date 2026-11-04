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


// Jest 27 does not understand nested package exports. Resolve the supported
// router DOM subpath with Node, which observes the package export map.
module.exports.jest = (config) => ({
  ...config,
  setupFiles: [...config.setupFiles, path.resolve(__dirname, "scripts/jest-platform.cjs")],
  moduleNameMapper: {
    ...config.moduleNameMapper,
    "^react-router/dom$": path.resolve(
      path.dirname(require.resolve("react-router/package.json")),
      require("react-router/package.json").exports["./dom"].default.default
    ),
  },
});


// Preserve CRA's middleware ordering with webpack-dev-server's supported API.
module.exports.devServer = (createConfig) => (proxy, allowedHost) => {
  const config = createConfig(proxy, allowedHost);
  // Keep validation enabled even when CRA defaults to accepting every host.
  // An explicitly configured LAN hostname remains supported.
  if (config.allowedHosts === "all" || config.allowedHosts == null) {
    config.allowedHosts = "auto";
  }
  if (Array.isArray(config.allowedHosts)) {
    config.allowedHosts = config.allowedHosts.filter(Boolean);
    if (!config.allowedHosts.length) config.allowedHosts = "auto";
  }
  const { onBeforeSetupMiddleware, onAfterSetupMiddleware, https } = config;
  delete config.onBeforeSetupMiddleware;
  delete config.onAfterSetupMiddleware;
  delete config.https;
  if (https) config.server = { type: "https", options: https === true ? {} : https };
  config.setupMiddlewares = (middlewares, devServer) => {
    // CRA's signal handler calls close(); version5 exposes stopCallback().
    devServer.close = (callback) => devServer.stopCallback(callback || (() => {}));
    const guards = ["host-header-check", "cross-origin-header-check"].map(
      (name) => middlewares.findIndex((middleware) => middleware.name === name)
    );
    if (guards.some((index) => index < 0)) {
      throw new Error("webpack-dev-server request security guards are required");
    }
    const before = require("express").Router();
    const beforeServer = Object.assign(Object.create(devServer), { app: before });
    // CRA's source-map endpoint reads the old stats property dynamically.
    Object.defineProperty(beforeServer, "_stats", {
      get: () => devServer.stats ?? devServer._stats,
    });
    onBeforeSetupMiddleware?.(beforeServer);
    const tail = require("express").Router();
    onAfterSetupMiddleware?.(Object.assign(Object.create(devServer), { app: tail }));
    const boundary = Math.max(...guards) + 1;
    return [
      ...middlewares.slice(0, boundary),
      { name: "classic-source-and-proxy", middleware: before },
      ...middlewares.slice(boundary),
      { name: "classic-history-and-service-worker", middleware: tail },
    ];
  };
  return config;
};
