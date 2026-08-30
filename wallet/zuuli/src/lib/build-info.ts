export type BuildInfo = Readonly<{
  productName: "ZUULI";
  applicationId: "cash.free2z.zuuli";
  version: string;
  build: number;
  channel: "internal" | "beta" | "stable";
  platform: "android" | "ios" | "linux" | "macos" | "windows" | "web";
  sourceCommit: string | null;
}>;

const CHANNEL_LABELS: Record<BuildInfo["channel"], string> = {
  internal: "Internal",
  beta: "Beta",
  stable: "Stable",
};

const PLATFORM_LABELS: Record<BuildInfo["platform"], string> = {
  android: "Android",
  ios: "iOS",
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
  web: "Web",
};

export const BUILD_INFO: BuildInfo = Object.freeze({
  ...__ZUULI_BUILD_INFO__,
});

export function buildChannelLabel(channel: BuildInfo["channel"]) {
  return CHANNEL_LABELS[channel];
}

export function buildPlatformLabel(platform: BuildInfo["platform"]) {
  return PLATFORM_LABELS[platform];
}

export function shortSourceCommit(sourceCommit: string | null) {
  return sourceCommit ? sourceCommit.slice(0, 12) : null;
}

type MinimalBuildInfo = Pick<
  BuildInfo,
  "productName" | "version" | "build" | "channel" | "platform" | "sourceCommit"
>;

/** Stable support block. This type cannot accept user or device state. */
export function formatBuildInfoMinimal(info: MinimalBuildInfo = BUILD_INFO) {
  return [
    info.productName,
    `Version: ${info.version}`,
    `Build: ${info.build}`,
    `Channel: ${buildChannelLabel(info.channel)}`,
    `Platform: ${buildPlatformLabel(info.platform)}`,
    `Source commit: ${shortSourceCommit(info.sourceCommit) ?? "Unavailable in this build"}`,
  ].join("\n");
}

/** Complete immutable provenance for the on-screen disclosure. */
export function formatBuildInfoProvenance(info: BuildInfo = BUILD_INFO) {
  return [
    formatBuildInfoMinimal(info),
    `Application ID: ${info.applicationId}`,
    `Full source commit: ${info.sourceCommit ?? "Unavailable in this build"}`,
    "Metadata source: Embedded at build time",
  ].join("\n");
}

