export type EmbeddedBuildIdentity = Readonly<{
  productName: "ZUULI";
  applicationId: "cash.free2z.zuuli";
  version: string;
  build: number;
  channel: "internal" | "beta" | "stable";
  platform: "android" | "ios" | "linux" | "macos" | "windows" | "web";
  sourceCommit: string | null;
}>;

export function loadBuildIdentity(options: {
  root: string;
  env?: NodeJS.ProcessEnv;
}): EmbeddedBuildIdentity;

