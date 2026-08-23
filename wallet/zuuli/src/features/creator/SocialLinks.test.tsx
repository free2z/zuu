import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseBioFrontmatter } from "@/lib/utils/bio";
import { CreatorSocialLinks } from "./SocialLinks";

const BRANDED_CASES = [
  ["twitter", "alice", "X", "x.com"],
  ["github", "alice", "GitHub", "github.com"],
  ["instagram", "alice", "Instagram", "instagram.com"],
  ["youtube", "alice", "YouTube", "youtube.com"],
  ["facebook", "alice", "Facebook", "facebook.com"],
  ["linkedin", "alice", "LinkedIn", "linkedin.com"],
  ["reddit", "alice", "Reddit", "reddit.com"],
  ["telegram", "alice", "Telegram", "t.me"],
  ["nostr", "npub1alice", "Nostr", "njump.me"],
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
  it("renders every validated platform with its trusted label", () => {
    const values = BRANDED_CASES.map(([key, handle]) => `  ${key}: ${handle}`).join(
      "\n",
    );
    const markup = render(values);

    expect(markup.match(/data-social-trust="branded"/g)).toHaveLength(
      BRANDED_CASES.length,
    );
    for (const [, , label, canonicalHost] of BRANDED_CASES) {
      expect(markup).toContain(`aria-label="Alice on ${label}"`);
      expect(markup).toContain(`data-destination-host="${canonicalHost}"`);
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
