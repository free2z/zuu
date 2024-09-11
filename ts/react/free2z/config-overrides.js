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

