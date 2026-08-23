/// <reference types="vite/client" />

declare module "*?init&no-inline" {
  const initialize: (
    imports?: WebAssembly.Imports,
  ) => Promise<WebAssembly.Instance>;
  export default initialize;
}
