// JSDOM 16 predates these browser encoding APIs used by React Router.
const { TextEncoder, TextDecoder } = require("node:util");
globalThis.TextEncoder ??= TextEncoder;
globalThis.TextDecoder ??= TextDecoder;
