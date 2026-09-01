/// <reference types="vite/client" />

declare const __ZUULI_BUILD_INFO__: Readonly<{
  productName: "ZUULI";
  applicationId: "cash.free2z.zuuli";
  version: string;
  build: number;
  channel: "internal" | "beta" | "stable";
  platform: "android" | "ios" | "linux" | "macos" | "windows" | "web";
  sourceCommit: string | null;
}>;

declare module "*?init&no-inline" {
  const initialize: (
    imports?: WebAssembly.Imports,
  ) => Promise<WebAssembly.Instance>;
  export default initialize;
}
