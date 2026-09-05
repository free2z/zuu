import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { Markdown, type MarkdownVariant } from "./Markdown";

function render(source: string, variant: MarkdownVariant = "article") {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Markdown variant={variant}>{source}</Markdown>
    </MemoryRouter>,
  );
}

describe("native provider embeds", () => {
  it.each([
    {
      provider: "youtube",
      source: "::embed[https://youtu.be/NativeBoundary01]",
      href: "https://www.youtube.com/watch?v=NativeBoundary01",
      label: "Open YouTube video outside free2z",
    },
    {
      provider: "vimeo",
      source: "::embed[https://player.vimeo.com/video/123456789]",
      href: "https://vimeo.com/123456789",
      label: "Open Vimeo video outside free2z",
    },
  ])("externalizes $provider without creating remote frame authority", (media) => {
    const markup = render(media.source);

    expect(markup).toContain(`data-native-external-embed="${media.provider}"`);
    expect(markup).toContain(`href="${media.href}"`);
    expect(markup).toContain(media.label);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("data-remote-media-consent");
  });

  it("applies the same native boundary to untrusted comments", () => {
    const markup = render(
      "::embed[https://vimeo.com/987654321]",
      "comment",
    );

    expect(markup).toContain('data-native-external-embed="vimeo"');
    expect(markup).not.toContain("<iframe");
  });
});
