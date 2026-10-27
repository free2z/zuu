import {
  classicPageCanonicalPath,
  isClassicStreamType,
  resolveClassicPageOwner,
} from "./classicRouteCompatibility";

describe("classicPageCanonicalPath", () => {
  it("emits the canonical two-segment page route", () => {
    expect(
      classicPageCanonicalPath({
        creator: { username: "creator name" },
        vanity: "page name",
        free2zaddr: "zs-safe",
      }),
    ).toBe("/creator%20name/page%20name");
  });

  it("uses the immutable route when a product route would collide", () => {
    expect(
      classicPageCanonicalPath({
        creator: { username: "api" },
        vanity: "page",
        free2zaddr: "zs-safe/value",
      }),
    ).toBe("/article/zs-safe%2Fvalue");
  });

  it("refuses to emit an unverifiable page path", () => {
    expect(
      classicPageCanonicalPath({
        creator: { username: "creator" },
        vanity: "dashboard",
      }),
    ).toBeUndefined();
  });
});
import { readFileSync } from "node:fs";

describe("isClassicStreamType", () => {
  it.each([
    "broadcast",
    "ppv",
    "subscribers-only",
    "Broadcast",
    "PPV",
    "Subscribers-Only",
  ])(
    "keeps the historic case-insensitive %s route on the live-stream client",
    (segment) => expect(isClassicStreamType(segment)).toBe(true),
  );

  it.each(["article", undefined])(
    "keeps the legacy vanity %s on the article client",
    (segment) => expect(isClassicStreamType(segment)).toBe(false),
  );
});

describe("resolveClassicPageOwner", () => {
  const attackerPage = {
    creator: { username: "attacker" },
    vanity: "support-skylar",
    free2zaddr: "immutable-address",
  };

  it("removes globally resolved attacker content from a trusted creator URL", () => {
    expect(resolveClassicPageOwner("skylar", attackerPage)).toEqual({
      status: "redirect",
      path: "/attacker/support-skylar",
    });
  });

  it("does not redirect a page whose returned creator matches the URL", () => {
    expect(resolveClassicPageOwner("attacker", attackerPage)).toEqual({
      status: "verified",
    });
  });

  it("uses the immutable address and encodes both canonical segments", () => {
    expect(
      resolveClassicPageOwner("trusted", {
        creator: { username: "real creator" },
        vanity: null,
        free2zaddr: "address/with slash",
      }),
    ).toEqual({
      status: "redirect",
      path: "/real%20creator/address%2Fwith%20slash",
    });
  });

  it.each([
    "broadcast",
    "dashboard",
    "null",
    "ppv",
    "private",
    "subscribers-only",
    "undefined",
    "zpage",
  ])("does not redirect reserved vanity %s into a product route", (vanity) => {
    expect(
      resolveClassicPageOwner("old-owner", {
        creator: { username: "actual-owner" },
        vanity,
        free2zaddr: "immutable-address",
      }),
    ).toEqual({
      status: "redirect",
      path: "/actual-owner/immutable-address",
    });
  });

  it("uses a safe vanity when a grandfathered immutable address is reserved", () => {
    expect(
      resolveClassicPageOwner("old-owner", {
        creator: { username: "actual-owner" },
        vanity: "ordinary-vanity",
        free2zaddr: "broadcast",
      }),
    ).toEqual({
      status: "redirect",
      path: "/actual-owner/ordinary-vanity",
    });
  });

  it.each([
    ["ai", "ordinary-vanity"],
    ["article", "ordinary-vanity"],
    ["checkout", "ordinary-vanity"],
    ["converse", "ordinary-vanity"],
    ["edit", "ordinary-vanity"],
    ["live", "ordinary-vanity"],
    ["projects", "ordinary-vanity"],
    ["tag", "ordinary-vanity"],
    ["begin", "alt"],
    ["profile", "kyc"],
    ["profile", "uploads"],
    ["sitemap", "static.xml"],
    ["tools", "p2pe2e"],
    ["api", "ordinary-vanity"],
    ["adminzzz", "ordinary-vanity"],
    ["feeds", "ordinary-vanity"],
    ["uploads", "ordinary-vanity"],
    ["uploadz", "ordinary-vanity"],
    ["djstatic", "ordinary-vanity"],
    ["static", "ordinary-vanity"],
    ["docs", "ordinary-vanity"],
    ["ws", "ordinary-vanity"],
    ["_app", "ordinary-vanity"],
    ["gcsproxy", "ordinary-vanity"],
    ["try-new-ui", "ordinary-vanity"],
    ["classic-ui", "ordinary-vanity"],
  ])(
    "uses the cross-UI article route for reserved owner path %s/%s",
    (username, vanity) => {
      expect(
        resolveClassicPageOwner(username, {
          creator: { username },
          vanity,
          free2zaddr: "immutable-address",
        }),
      ).toEqual({
        status: "redirect",
        path: "/article/immutable-address",
      });
    },
  );

  it("keeps a non-literal child of a partly reserved owner on its pretty URL", () => {
    expect(
      resolveClassicPageOwner("profile", {
        creator: { username: "profile" },
        vanity: "ordinary-vanity",
        free2zaddr: "immutable-address",
      }),
    ).toEqual({ status: "verified" });
  });

  it("fails closed when every returned identifier names a product route", () => {
    expect(
      resolveClassicPageOwner("old-owner", {
        creator: { username: "actual-owner" },
        vanity: "broadcast",
        free2zaddr: "ppv",
      }),
    ).toEqual({ status: "unverifiable" });
  });

  it("fails closed when the response cannot prove its owner", () => {
    expect(
      resolveClassicPageOwner("trusted", {
        vanity: "support-skylar",
      }),
    ).toEqual({ status: "unverifiable" });
  });
});

it("the classic rollback app serves the cross-UI article escape hatch", () => {
  const app = readFileSync(`${__dirname}/App.tsx`, "utf8");
  expect(app).toMatch(/path=["']\/article\/:id["'][\s\S]*?<PageDetail\s*\/>/);
});

it("the retained editor no longer emits the legacy zPage route", () => {
  const editor = readFileSync(`${__dirname}/EditPage.tsx`, "utf8");
  expect(editor).toContain("classicPageCanonicalPath");
  expect(editor).not.toMatch(/free2z\.cash\/\$\{[^}]+\}\/zpage\//);
  expect(editor).not.toMatch(/navigate\(`\/\$\{[^}]+\}\/zpage\//);
});
