import {
  resolveAboutMessages,
  type AboutMessages,
} from "./about-copy";

export type BuildInfo = Readonly<{
  productName: "ZUULI";
  applicationId: "cash.free2z.zuuli";
  version: string;
  build: number;
  channel: "internal" | "beta" | "stable";
  platform: "android" | "ios" | "linux" | "macos" | "windows" | "web";
  sourceCommit: string | null;
}>;

export const BUILD_INFO: BuildInfo = Object.freeze({
  ...__ZUULI_BUILD_INFO__,
});

export function buildChannelLabel(
  channel: BuildInfo["channel"],
  messages: AboutMessages = resolveAboutMessages(),
) {
  return {
    internal: messages.channelInternal,
    beta: messages.channelBeta,
    stable: messages.channelStable,
  }[channel];
}

export function buildPlatformLabel(
  platform: BuildInfo["platform"],
  messages: AboutMessages = resolveAboutMessages(),
) {
  return {
    android: messages.platformAndroid,
    ios: messages.platformIos,
    linux: messages.platformLinux,
    macos: messages.platformMacos,
    windows: messages.platformWindows,
    web: messages.platformWeb,
  }[platform];
}

export function shortSourceCommit(sourceCommit: string | null) {
  return sourceCommit ? sourceCommit.slice(0, 12) : null;
}

type MinimalBuildInfo = Pick<
  BuildInfo,
  "productName" | "version" | "build" | "channel" | "platform" | "sourceCommit"
>;

/** Stable support block. This type cannot accept user or device state. */
export function formatBuildInfoMinimal(
  info: MinimalBuildInfo = BUILD_INFO,
  messages: AboutMessages = resolveAboutMessages(),
) {
  return [
    info.productName,
    `${messages.versionLabel}: ${info.version}`,
    `${messages.buildLabel}: ${info.build}`,
    `${messages.channelLabel}: ${buildChannelLabel(info.channel, messages)}`,
    `${messages.platformLabel}: ${buildPlatformLabel(info.platform, messages)}`,
    `${messages.commitLabel}: ${shortSourceCommit(info.sourceCommit) ?? messages.unavailable}`,
  ].join("\n");
}

/** Complete immutable provenance for the on-screen disclosure. */
export function formatBuildInfoProvenance(
  info: BuildInfo = BUILD_INFO,
  messages: AboutMessages = resolveAboutMessages(),
) {
  return [
    formatBuildInfoMinimal(info, messages),
    `${messages.applicationIdLabel}: ${info.applicationId}`,
    `${messages.fullCommitLabel}: ${info.sourceCommit ?? messages.unavailable}`,
    `${messages.metadataSourceLabel}: ${messages.metadataSourceValue}`,
  ].join("\n");
}
