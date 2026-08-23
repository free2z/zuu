import { describe, expect, it } from "vitest";
import { parseBioFrontmatter, type SocialKey } from "./bio";

type BrandedCase = {
  key: Exclude<SocialKey, "mastodon" | "website">;
  label: string;
  handle: string;
  handleUrl: string;
  acceptedUrl: string;
  canonicalUrl: string;
  canonicalHost: string;
};

const BRANDED_CASES: readonly BrandedCase[] = [
  {
    key: "twitter",
    label: "X",
    handle: "_alice2",
    handleUrl: "https://x.com/_alice2",
    acceptedUrl: "https://www.twitter.com/_alice2",
    canonicalUrl: "https://x.com/_alice2",
    canonicalHost: "x.com",
  },
  {
    key: "github",
    label: "GitHub",
    handle: "alice-dev",
    handleUrl: "https://github.com/alice-dev",
    acceptedUrl: "https://www.github.com/alice-dev",
    canonicalUrl: "https://github.com/alice-dev",
    canonicalHost: "github.com",
  },
  {
    key: "instagram",
    label: "Instagram",
    handle: "alice.photo",
    handleUrl: "https://instagram.com/alice.photo",
    acceptedUrl: "https://www.instagram.com/alice.photo",
    canonicalUrl: "https://instagram.com/alice.photo",
    canonicalHost: "instagram.com",
  },
  {
    key: "youtube",
    label: "YouTube",
    handle: "@alice-video",
    handleUrl: "https://youtube.com/@alice-video",
    acceptedUrl: "https://www.youtube.com/@alice-video",
    canonicalUrl: "https://youtube.com/@alice-video",
    canonicalHost: "youtube.com",
  },
  {
    key: "facebook",
    label: "Facebook",
    handle: "alice.page",
    handleUrl: "https://facebook.com/alice.page",
    acceptedUrl: "https://www.facebook.com/alice.page",
    canonicalUrl: "https://facebook.com/alice.page",
    canonicalHost: "facebook.com",
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    handle: "in/alice-dev",
    handleUrl: "https://linkedin.com/in/alice-dev",
    acceptedUrl: "https://www.linkedin.com/in/alice-dev",
    canonicalUrl: "https://linkedin.com/in/alice-dev",
    canonicalHost: "linkedin.com",
  },
  {
    key: "reddit",
    label: "Reddit",
    handle: "u/alice_dev",
    handleUrl: "https://reddit.com/u/alice_dev",
    acceptedUrl: "https://old.reddit.com/u/alice_dev",
    canonicalUrl: "https://reddit.com/u/alice_dev",
    canonicalHost: "reddit.com",
  },
  {
    key: "telegram",
    label: "Telegram",
    handle: "@alice_dev",
    handleUrl: "https://t.me/alice_dev",
    acceptedUrl: "https://telegram.me/alice_dev",
    canonicalUrl: "https://t.me/alice_dev",
    canonicalHost: "t.me",
  },
  {
    key: "nostr",
    label: "Nostr",
    handle: "nostr:npub1alice",
    handleUrl: "https://njump.me/npub1alice",
    acceptedUrl: "https://www.njump.me/npub1alice",
    canonicalUrl: "https://njump.me/npub1alice",
    canonicalHost: "njump.me",
  },
] as const;

function oneSocial(key: string, value: string) {
  return parseBioFrontmatter(
    `---\nsocials:\n  ${key}: "${value}"\n---\n\nVisible bio`,
  );
}

function unicodeLookalike(host: string): string {
  const index = host.lastIndexOf("m");
  return `${host.slice(0, index)}м${host.slice(index + 1)}`;
}

describe("creator bio branded social links", () => {
  it.each(BRANDED_CASES)(
    "canonicalizes a $key handle onto its reviewed host",
    ({ key, label, handle, handleUrl, canonicalHost }) => {
      const parsed = oneSocial(key, handle);
      expect(parsed.body).toBe("Visible bio");
      expect(parsed.socials).toEqual([
        expect.objectContaining({
          key,
          label,
          url: handleUrl,
          trust: "branded",
          destinationHost: canonicalHost,
        }),
      ]);
    },
  );

  it.each(BRANDED_CASES)(
    "canonicalizes the explicit reviewed $key host aliases",
    ({ key, acceptedUrl, canonicalUrl, canonicalHost }) => {
      expect(oneSocial(key, acceptedUrl).socials).toEqual([
        expect.objectContaining({
          key,
          url: canonicalUrl,
          trust: "branded",
          destinationHost: canonicalHost,
        }),
      ]);
    },
  );

  for (const { key, canonicalHost } of BRANDED_CASES) {
    const attacks = [
      ["plain HTTP", `http://${canonicalHost}/alice`],
      ["userinfo", `https://attacker.test@${canonicalHost}/alice`],
      ["suffix match", `https://${canonicalHost}.attacker.test/alice`],
      ["Unicode lookalike", `https://${unicodeLookalike(canonicalHost)}/alice`],
      [
        "encoded hostname",
        `https://%${canonicalHost.charCodeAt(0).toString(16)}${canonicalHost.slice(1)}/alice`,
      ],
      ["non-default port", `https://${canonicalHost}:444/alice`],
      ["unreviewed redirector subdomain", `https://l.${canonicalHost}/alice`],
    ] as const;

    it.each(attacks)(`rejects ${key} %s attacks`, (_name, attack) => {
      expect(oneSocial(key, attack).socials).toEqual([]);
    });
  }

  it("accepts an explicit default HTTPS port and removes it canonically", () => {
    expect(oneSocial("github", "https://github.com:443/alice").socials[0]?.url).toBe(
      "https://github.com/alice",
    );
  });

  it("fails closed for a stored branded value while preserving the visible bio", () => {
    const parsed = oneSocial("github", "https://github.com.attacker.test/phish");
    expect(parsed).toEqual({ body: "Visible bio", socials: [] });
  });
});

describe("creator bio generic links", () => {
  it("requires HTTPS and exposes the browser-canonical website host", () => {
    const social = oneSocial("website", "docs.example:8443/projects").socials[0];
    expect(social).toEqual(
      expect.objectContaining({
        url: "https://docs.example:8443/projects",
        display: "docs.example:8443",
        trust: "generic",
        destinationHost: "docs.example:8443",
      }),
    );
    expect(oneSocial("website", "http://docs.example/projects").socials).toEqual([]);
    expect(oneSocial("website", "https://reader@docs.example/projects").socials).toEqual(
      [],
    );
  });

  it("canonicalizes a federated Mastodon handle and exposes its instance", () => {
    expect(oneSocial("mastodon", "@alice@social.example").socials).toEqual([
      expect.objectContaining({
        url: "https://social.example/@alice",
        display: "social.example",
        trust: "generic",
        destinationHost: "social.example",
      }),
    ]);
  });

  it("rejects insecure or credential-bearing Mastodon URLs", () => {
    expect(oneSocial("mastodon", "http://social.example/@alice").socials).toEqual([]);
    expect(
      oneSocial("mastodon", "https://alice@social.example/@alice").socials,
    ).toEqual([]);
  });
});
