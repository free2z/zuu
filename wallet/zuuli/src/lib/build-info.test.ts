import { describe, expect, it } from "vitest";
import release from "../../release.json";
import buildMetadata from "../../build-info.json";
import {
  BUILD_INFO,
  formatBuildInfoMinimal,
  formatBuildInfoProvenance,
  shortSourceCommit,
  type BuildInfo,
} from "./build-info";
import { truncateAddress } from "./format";

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
    expect(BUILD_INFO.channel).toBe(buildMetadata.channel);
    expect(BUILD_INFO.applicationId).toBe(release.applicationId);
    expect(Object.isFrozen(BUILD_INFO)).toBe(true);
    if (BUILD_INFO.sourceCommit !== null) {
      expect(BUILD_INFO.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    }
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
      "ZUULI\nVersion: 1.2.3\nBuild: 45\nRelease channel: Internal\nPlatform: iOS\nSource commit: abcdef01…89abcdef01",
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

  it("shortens the source commit in the middle, tail-weighted, not by head prefix (#829)", () => {
    // Pin the exact format so it cannot regress back to a head-only prefix.
    expect(shortSourceCommit(INFO.sourceCommit)).toBe("abcdef01…89abcdef01");
    // Reuses the shared opaque-identifier helper rather than reimplementing it.
    expect(shortSourceCommit(INFO.sourceCommit)).toBe(
      truncateAddress(INFO.sourceCommit as string),
    );
    expect(shortSourceCommit(null)).toBeNull();
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
