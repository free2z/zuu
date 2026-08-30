import { describe, expect, it } from "vitest";
import release from "../../release.json";
import {
  BUILD_INFO,
  formatBuildInfoMinimal,
  formatBuildInfoProvenance,
  type BuildInfo,
} from "./build-info";

const INFO: BuildInfo = {
  productName: "ZUULI",
  applicationId: "cash.free2z.zuuli",
  version: "1.2.3",
  build: 45,
  channel: "internal",
  platform: "ios",
  sourceCommit: "abcdef0123456789abcdef0123456789abcdef01",
};

describe("immutable build info", () => {
  it("agrees with the canonical release artifact identity", () => {
    expect(BUILD_INFO.version).toBe(release.version);
    expect(BUILD_INFO.build).toBe(release.build);
    expect(BUILD_INFO.channel).toBe(release.channel);
    expect(BUILD_INFO.applicationId).toBe(release.applicationId);
    expect(Object.isFrozen(BUILD_INFO)).toBe(true);
    expect(BUILD_INFO.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("produces one stable minimal block and excludes private/runtime fields", () => {
    const hostile = {
      ...INFO,
      account: "alice@example.com",
      walletAddress: "u1secret",
      deviceName: "Alice's phone",
      balance: "42 ZEC",
      path: "/Users/alice/private",
    };
    const text = formatBuildInfoMinimal(hostile);

    expect(text).toBe(
      "ZUULI\nVersion: 1.2.3\nBuild: 45\nChannel: Internal\nPlatform: iOS\nSource commit: abcdef012345",
    );
    for (const secret of [
      hostile.account,
      hostile.walletAddress,
      hostile.deviceName,
      hostile.balance,
      hostile.path,
      INFO.applicationId,
      INFO.sourceCommit,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("labels absent optional provenance honestly", () => {
    const unavailable = { ...INFO, sourceCommit: null };
    expect(formatBuildInfoMinimal(unavailable)).toContain(
      "Source commit: Unavailable in this build",
    );
    expect(formatBuildInfoProvenance(unavailable)).toContain(
      "Full source commit: Unavailable in this build",
    );
    expect(formatBuildInfoProvenance(unavailable)).not.toMatch(
      /unknown|placeholder|debug|0{12}/i,
    );
  });
});

