import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseBioFrontmatter } from "@/lib/utils/bio";
import { CreatorSocialLinks } from "./SocialLinks";

const AMBIGUOUS_CASES = [
  ["twitter", "alice", "X", "x.com", "lucide-twitter"],
  ["github", "alice", "GitHub", "github.com", "lucide-github"],
  ["instagram", "alice", "Instagram", "instagram.com", "lucide-instagram"],
  ["facebook", "alice", "Facebook", "facebook.com", "lucide-facebook"],
  ["telegram", "alice", "Telegram", "t.me", "lucide-send"],
  ["nostr", "npub1alice", "Nostr", "njump.me", "lucide-zap"],
] as const;

const BRANDED_CASES = [
  ["youtube", "alice", "YouTube", "youtube.com"],
  ["linkedin", "alice", "LinkedIn", "linkedin.com"],
  ["reddit", "alice", "Reddit", "reddit.com"],
] as const;

function socials(values: string) {
  return parseBioFrontmatter(`---\nsocials:\n${values}\n---`).socials;
}

function render(values: string): string {
  return renderToStaticMarkup(
    <CreatorSocialLinks creatorName="Alice" socials={socials(values)} />,
  );
}

describe("creator social-link UI", () => {
  it("brands only structurally unambiguous profiles", () => {
    const values = [...AMBIGUOUS_CASES, ...BRANDED_CASES]
      .map(([key, handle]) => `  ${key}: ${handle}`)
      .join("\n");
    const markup = render(values);

    expect(markup.match(/data-social-trust="branded"/g)).toHaveLength(
      BRANDED_CASES.length,
    );
    expect(markup.match(/data-social-trust="generic"/g)).toHaveLength(
      AMBIGUOUS_CASES.length,
    );
    for (const [, , label, canonicalHost] of BRANDED_CASES) {
      expect(markup).toContain(`aria-label="Alice on ${label}"`);
      expect(markup).toContain(`data-destination-host="${canonicalHost}"`);
    }
    for (const [, , label, canonicalHost, iconClass] of AMBIGUOUS_CASES) {
      expect(markup).not.toContain(`aria-label="Alice on ${label}"`);
      expect(markup).toContain(`aria-label="Alice link to ${canonicalHost}"`);
      expect(markup).toContain(`>${canonicalHost}</span>`);
      expect(markup).not.toContain(iconClass);
    }
  });

  it("never brands route-like plain handles", () => {
    const markup = render(
      "  twitter: about\n" +
        "  github: contact\n" +
        "  instagram: rules\n" +
        "  facebook: help\n" +
        "  telegram: rules\n" +
        "  nostr: contact",
    );

    expect(markup.match(/data-social-trust="generic"/g)).toHaveLength(6);
    expect(markup).not.toContain('data-social-trust="branded"');
    for (const host of [
      "x.com",
      "github.com",
      "instagram.com",
      "facebook.com",
      "t.me",
      "njump.me",
    ]) {
      expect(markup).toContain(`Alice link to ${host}`);
      expect(markup).toContain(`>${host}</span>`);
    }
  });

  it("shows effective website and federated hosts as generic destinations", () => {
    const markup = render(
      "  website: https://portfolio.example:8443/work\n" +
        "  mastodon: @alice@social.example",
    );

    expect(markup.match(/data-social-trust="generic"/g)).toHaveLength(2);
    expect(markup).toContain("Alice link to portfolio.example:8443");
    expect(markup).toContain(">portfolio.example:8443</span>");
    expect(markup).toContain("Alice link to social.example");
    expect(markup).toContain(">social.example</span>");
  });

  it("does not render branding or navigation for an invalid stored platform URL", () => {
    const markup = render(
      "  github: https://github.com.attacker.test/phish\n" +
        "  website: safe.example",
    );

    expect(markup).not.toContain("Alice on GitHub");
    expect(markup).not.toContain("lucide-github");
    expect(markup).not.toContain("github.com.attacker.test");
    expect(markup).toContain("Alice link to safe.example");
  });
});
