import { describe, expect, it } from "vitest";
import {
  downloadTrustedFirstPartyImage,
  isTrustedFirstPartyImageTarget,
  normalizeRemoteMediaTarget,
  type RemoteMediaTarget,
} from "./remote-media-policy";

const BASE = "https://media.free2z.test/root/";

describe("remote media URL policy", () => {
  it.each([
    ["https://EXAMPLE.com./image.png", "https://example.com/image.png", "example.com"],
    ["//CDN.example/path.png", "https://cdn.example/path.png", "cdn.example"],
    ["/uploadz/a.png", "https://media.free2z.test/uploadz/a.png", "media.free2z.test"],
    ["clip.mp3", "https://media.free2z.test/root/clip.mp3", "media.free2z.test"],
    ["https://%65xample.com/%70ixel.png", "https://example.com/%70ixel.png", "example.com"],
  ])("normalizes %s without a request", (source, url, hostname) => {
    expect(normalizeRemoteMediaTarget(source, BASE)).toEqual({ url, hostname });
  });

  it.each([
    "",
    "   ",
    "data:image/png;base64,AAAA",
    "blob:https://example.com/id",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://tracker.example/pixel.png",
    "http://127.0.0.1:8080/video.mp4",
    "https://user@example.com/x.png",
    "https://user:pass@example.com/x.png",
    "https://exa\nmple.com/x.png",
    "https://[not-an-ipv6]/x.png",
  ])("fails closed for %j", (source) => {
    expect(normalizeRemoteMediaTarget(source, BASE)).toBeNull();
  });

  it("allows only the exact same-origin loopback HTTP development proxy", () => {
    expect(
      normalizeRemoteMediaTarget(
        "/uploadz/dev.png",
        "http://127.0.0.1:1432/articles/example",
      ),
    ).toEqual({
      url: "http://127.0.0.1:1432/uploadz/dev.png",
      hostname: "127.0.0.1",
    });
    expect(
      normalizeRemoteMediaTarget(
        "http://127.0.0.1:1423/uploadz/wrong-port.png",
        "http://127.0.0.1:1432/",
      ),
    ).toBeNull();
  });

  it("never double-decodes an encoded absolute URL into another origin", () => {
    const target = normalizeRemoteMediaTarget(
      "https%3A%2F%2Ftracker.example%2Fpixel.png",
      BASE,
    );

    expect(target?.hostname).toBe("media.free2z.test");
    expect(target?.url).not.toContain("tracker.example/");
  });

  it("fails closed across a deterministic control-character fuzz matrix", () => {
    for (let code = 0; code <= 0x7f; code += 1) {
      const char = String.fromCharCode(code);
      const target = normalizeRemoteMediaTarget(
        `https://example.com/a${char}b.png`,
        BASE,
      );
      if (code <= 0x1f || code === 0x7f) {
        expect(target, `code point ${code}`).toBeNull();
      } else {
        expect(target?.hostname, `code point ${code}`).toBe("example.com");
      }
    }
  });
});

describe("trusted Free2Z image origins", () => {
  const APP = "https://app.example/reader";

  it.each([
    "https://free2z.cash/image.png",
    "https://FREE2Z.CASH./image.png",
    "https://media.free2z.cash/image.png",
    "https://deep.media.free2z.cash/image.png",
    "https://free2z.cash:443/image.png",
  ])("approves the canonical HTTPS zone: %s", (source) => {
    const target = normalizeRemoteMediaTarget(source, APP);
    expect(target).not.toBeNull();
    expect(isTrustedFirstPartyImageTarget(target!, APP)).toBe(true);
  });

  it.each([
    "https://free2z.cash.evil.example/image.png",
    "https://notfree2z.cash/image.png",
    "https://free2z-cash.example/image.png",
    "https://free2z.com/image.png",
    "https://xn--free2z-9za.cash/image.png",
    "https://free2z.cash:8443/image.png",
    "http://free2z.cash/image.png",
  ])("does not approve lookalikes, other zones, ports, or schemes: %s", (source) => {
    const target = normalizeRemoteMediaTarget(source, APP);
    expect(
      target ? isTrustedFirstPartyImageTarget(target, APP) : false,
    ).toBe(false);
  });

  it("allows only the exact same-origin loopback development proxy", () => {
    const app = "http://127.0.0.1:1423/articles/example";
    const sameOrigin = normalizeRemoteMediaTarget("/uploadz/a.png", app)!;
    const otherPort = normalizeRemoteMediaTarget(
      "http://127.0.0.1:1424/uploadz/a.png",
      app,
    );
    expect(isTrustedFirstPartyImageTarget(sameOrigin, app)).toBe(true);
    expect(otherPort).toBeNull();
  });
});

describe("trusted Free2Z image download", () => {
  const APP = "https://app.example/reader";
  const START: RemoteMediaTarget = {
    url: "https://free2z.cash/uploadz/start.png",
    hostname: "free2z.cash",
  };

  it("revalidates every first-party hop before returning image bytes", async () => {
    const requested: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      new Response(null, {
        status: 302,
        headers: { location: "https://media.free2z.cash/second.png" },
      }),
      new Response(null, {
        status: 307,
        headers: { location: "../final.png" },
      }),
      new Response("safe", {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "4" },
      }),
    ];
    const fetchImage = async (url: string, init: RequestInit) => {
      requested.push({ url, init });
      return responses.shift()!;
    };

    const blob = await downloadTrustedFirstPartyImage(
      START,
      APP,
      fetchImage,
    );

    expect(await blob.text()).toBe("safe");
    expect(requested.map(({ url }) => url)).toEqual([
      "https://free2z.cash/uploadz/start.png",
      "https://media.free2z.cash/second.png",
      "https://media.free2z.cash/final.png",
    ]);
    expect(
      requested.every(
        ({ init }) =>
          init.redirect === "manual" &&
          init.credentials === "omit" &&
          init.referrerPolicy === "no-referrer",
      ),
    ).toBe(true);
  });

  it.each([
    "https://free2z.cash.evil.example/pixel.png",
    "https://tracker.example/pixel.png",
    "http://free2z.cash/pixel.png",
    "https://free2z.cash:8443/pixel.png",
  ])("stops before requesting an unapproved redirect: %s", async (location) => {
    const requested: string[] = [];
    const fetchImage = async (url: string) => {
      requested.push(url);
      return new Response(null, { status: 302, headers: { location } });
    };

    await expect(
      downloadTrustedFirstPartyImage(START, APP, fetchImage),
    ).rejects.toThrow("left the approved origin");
    expect(requested).toEqual([START.url]);
  });

  it("fails closed when the browser conceals a redirect", async () => {
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, "type", { value: "opaqueredirect" });

    await expect(
      downloadTrustedFirstPartyImage(START, APP, async () => opaque),
    ).rejects.toThrow("could not be verified");
  });

  it("rejects non-image responses", async () => {
    await expect(
      downloadTrustedFirstPartyImage(
        START,
        APP,
        async () =>
          new Response("not an image", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    ).rejects.toThrow("wrong type");
  });

  it("rejects SVG because it can carry attacker-selected subresources", async () => {
    await expect(
      downloadTrustedFirstPartyImage(
        START,
        APP,
        async () =>
          new Response("<svg/>", {
            status: 200,
            headers: { "content-type": "image/svg+xml" },
          }),
      ),
    ).rejects.toThrow("wrong type");
  });

  it("stops at the redirect cap", async () => {
    let requests = 0;
    await expect(
      downloadTrustedFirstPartyImage(START, APP, async () => {
        requests += 1;
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://hop${requests}.free2z.cash/image.png`,
          },
        });
      }),
    ).rejects.toThrow("Too many image redirects");
    expect(requests).toBe(6);
  });
});
