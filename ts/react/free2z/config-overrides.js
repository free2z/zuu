const { exit } = require("process")
const { getCombinedModifierFlags } = require("typescript")


// config-overrides.js
module.exports = function override(config, env) {
    // New config, e.g. config.plugins.push...

    console.log(config.resolve)
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
    }
    return config
}

module.exports.jest = function overrideJest(config) {
    // The production Markdown stack is ESM-only. Transform it in Jest so card
    // image tests execute the same parser instead of a mock or parallel parser.
    const parserTransformPattern =
        "node_modules/(?!(?:bail|character-entities|decode-named-character-reference|devlop|is-plain-obj|mdast-util-[^/]+|micromark(?:-[^/]*)?|remark-parse|trough|unified|unist-util-[^/]+|vfile(?:-message)?)/)"
    config.transformIgnorePatterns = config.transformIgnorePatterns.map(
        (pattern) =>
            pattern.includes("node_modules") ? parserTransformPattern : pattern
    )
    config.moduleNameMapper = {
        ...config.moduleNameMapper,
        "^#minpath$": "<rootDir>/node_modules/vfile/lib/minpath.js",
        "^#minproc$": "<rootDir>/node_modules/vfile/lib/minproc.js",
        "^#minurl$": "<rootDir>/node_modules/vfile/lib/minurl.js",
    }
    return config
}
