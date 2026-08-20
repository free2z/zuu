import { describe, expect, it } from "vitest";
import { normalizeRemoteMediaTarget } from "./remote-media-policy";

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
