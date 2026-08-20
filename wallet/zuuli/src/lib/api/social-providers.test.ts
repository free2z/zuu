import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({
  useMock: () => false,
}));

vi.mock("../oauth/transport", async (importOriginal) => {
  const original = await importOriginal<typeof import("../oauth/transport")>();
  return { ...original, oauthCallbackTransport: vi.fn() };
});

vi.mock("./http", async (importOriginal) => {
  const original = await importOriginal<typeof import("./http")>();
  return { ...original, request: vi.fn() };
});

import { auth } from "./free2z";
import { request } from "./http";
import { oauthCallbackTransport } from "../oauth/transport";
import {
  configuredSocialProviders,
  parseSocialProvidersStatus,
  SocialProvidersContractError,
} from "./social-providers";

const productionResponse = {
  providers: [
    { provider: "x", configured: true },
    { provider: "google", configured: false },
    { provider: "github", configured: false },
  ],
};

describe("social-provider discovery contract", () => {
  beforeEach(() => {
    vi.mocked(request).mockReset();
    vi.mocked(oauthCallbackTransport).mockReset();
    vi.mocked(oauthCallbackTransport).mockResolvedValue("web");
  });

  it("parses the production array and exposes configured X", () => {
    const status = parseSocialProvidersStatus(productionResponse);
    expect(status).toEqual({ x: true, google: false, github: false });
    expect(configuredSocialProviders(status)).toEqual(["x"]);
  });

  it("keeps a valid all-unconfigured response distinct from failure", () => {
    const status = parseSocialProvidersStatus({
      providers: [
        { provider: "x", configured: false },
        { provider: "google", configured: false },
        { provider: "github", configured: false },
      ],
    });
    expect(status).toEqual({ x: false, google: false, github: false });
    expect(configuredSocialProviders(status)).toEqual([]);
  });

  it("rejects omitted providers instead of fabricating an unconfigured value", () => {
    expect(() =>
      parseSocialProvidersStatus({
        providers: [{ provider: "x", configured: true }],
      }),
    ).toThrow(SocialProvidersContractError);
  });

  it("rejects a whole response containing an unknown provider", () => {
    expect(() =>
      parseSocialProvidersStatus({
        providers: [
          { provider: "x", configured: true },
          { provider: "facebook", configured: true },
        ],
      }),
    ).toThrow(SocialProvidersContractError);
  });

  it.each([
    ["null", null],
    ["missing providers", {}],
    ["non-array providers", { providers: {} }],
    ["legacy object map", { x: true, google: false, github: false }],
    ["extra top-level field", { providers: [], configured: true }],
    ["null entry", { providers: [null] }],
    ["missing configured", { providers: [{ provider: "x" }] }],
    [
      "non-boolean configured",
      { providers: [{ provider: "x", configured: "true" }] },
    ],
    [
      "extra entry field",
      { providers: [{ provider: "x", configured: true, url: "https://x.com" }] },
    ],
    [
      "duplicate provider",
      {
        providers: [
          { provider: "x", configured: true },
          { provider: "x", configured: false },
        ],
      },
    ],
  ])("fails closed for %s", (_name, response) => {
    expect(() => parseSocialProvidersStatus(response)).toThrow(
      SocialProvidersContractError,
    );
  });

  it("parses at the HTTP boundary instead of returning trusted JSON", async () => {
    vi.mocked(request).mockResolvedValue(productionResponse);

    await expect(auth.socialProviders()).resolves.toEqual({
      x: true,
      google: false,
      github: false,
    });
    expect(request).toHaveBeenCalledWith("/api/auth/social/providers/", {
      anonymous: true,
    });
  });

  it.each(["web", "desktop"] as const)(
    "uses anonymous generic discovery for %s",
    async (transport) => {
      vi.mocked(oauthCallbackTransport).mockResolvedValue(transport);
      vi.mocked(request).mockResolvedValue(productionResponse);

      await expect(auth.socialProviders()).resolves.toEqual({
        x: true,
        google: false,
        github: false,
      });
      expect(request).toHaveBeenCalledWith("/api/auth/social/providers/", {
        anonymous: true,
      });
    },
  );

  it("uses anonymous mobile-readiness discovery on iOS and Android", async () => {
    vi.mocked(oauthCallbackTransport).mockResolvedValue("mobile");
    vi.mocked(request).mockResolvedValue(productionResponse);

    await expect(auth.socialProviders()).resolves.toEqual({
      x: true,
      google: false,
      github: false,
    });
    expect(request).toHaveBeenCalledWith(
      "/api/auth/social/mobile/providers/",
      { anonymous: true },
    );
  });

  it("fails closed when native transport cannot be resolved", async () => {
    vi.mocked(oauthCallbackTransport).mockRejectedValue(
      new Error("native transport unavailable"),
    );

    await expect(auth.socialProviders()).rejects.toThrow(
      "native transport unavailable",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed HTTP success responses", async () => {
    vi.mocked(request).mockResolvedValue({ x: true });
    await expect(auth.socialProviders()).rejects.toBeInstanceOf(
      SocialProvidersContractError,
    );
  });
});
