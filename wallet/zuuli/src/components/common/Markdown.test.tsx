import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Markdown, type MarkdownVariant } from "./Markdown";

/**
 * `MarkdownLink` calls `useNavigate()`, so every render needs a router in
 * context (the comment variant routes images through it).
 */
function render(source: string, variant: MarkdownVariant): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Markdown variant={variant}>{source}</Markdown>
    </MemoryRouter>,
  );
}

const IMAGE = "![alt text](https://example.com/y.png)";

/**
 * The ErrorBoundary fallback is the raw source in a `whitespace-pre-wrap` div.
 * (Under `renderToStaticMarkup` an error boundary does not catch at all — the
 * throw propagates and fails the test outright — so this asserts the fallback
 * is absent in the client-render case too, without weakening the check.)
 */
function expectNoErrorFallback(markup: string) {
  expect(markup).not.toContain("whitespace-pre-wrap");
  expect(markup).not.toContain("![alt text]");
}

describe("Markdown images", () => {
  it("holds an article image behind destination-specific consent", () => {
    const markup = render(IMAGE, "article");

    expect(markup).not.toContain("<img");
    expect(markup).toContain('data-remote-media-host="example.com"');
    expect(markup).toContain('aria-label="Load image from example.com"');
    expectNoErrorFallback(markup);
  });

  it("uses the same one-item consent boundary for comments", () => {
    const markup = render(IMAGE, "comment");

    expect(markup).not.toContain("<img");
    expect(markup).toContain('data-remote-media-host="example.com"');
    expect(markup).toContain('aria-label="Load image from example.com"');
    expectNoErrorFallback(markup);
  });

  it("leaves a relative src alone when the media base is same-origin (dev proxy)", () => {
    // `MEDIA_BASE` is "" in dev / `tauri dev`, where the Vite proxy already
    // forwards `/uploadz` from the app's own origin. Absolutizing must be a
    // no-op there, not a mangled "undefined/uploadz/..." or a doubled slash.
    const markup = render(
      "![](/uploadz/public/palmar/elg03269-1.webp)",
      "article",
    );

    expect(markup).not.toContain("<img");
    expect(markup).toContain('data-remote-media-host="zuuli.invalid"');
  });
});

describe("Markdown links", () => {
  it("marks genuine inline prose links for the narrow touch-target exemption", () => {
    const markup = render("Read [the guide](/articles/guide).", "article");

    expect(markup).toContain('data-touch-target-exempt="inline-text"');
    expect(markup).toContain('href="/articles/guide"');
    expect(markup).toContain(">the guide</a>");
  });

  // free2z article bodies are authored on free2z.cash, where relative hrefs
  // mean free2z routes — which mostly don't exist in ZUULI (#337). These must
  // resolve to something real instead of dead-ending in `NotFound`.

  it("keeps a genuine ZUULI app route routed as-is", () => {
    const markup = render("[wallet](/wallet/send)", "article");

    expect(markup).toContain('href="/wallet/send"');
  });

  it("maps a free2z {username}/{slug} content link onto the in-app article route", () => {
    const markup = render("[post](/palmar/7th-meetup-zcash-club-queretaro)", "article");

    expect(markup).toContain('href="/articles/7th-meetup-zcash-club-queretaro"');
  });

  it("maps a free2z {username} link onto the in-app creator route", () => {
    const markup = render("[palmar](/palmar)", "article");

    expect(markup).toContain('href="/creator/palmar"');
  });

  it("routes an /uploadz link as out-of-app media instead of the SPA router", () => {
    const markup = render(
      "[report](/uploadz/public/x/report.pdf)",
      "article",
    );

    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });
});

/**
 * free2z stores article bodies with ORIGIN-RELATIVE upload paths, e.g.
 * `![](/uploadz/public/palmar/elg03269-1.webp)`. Those only resolve when the
 * document itself is served from free2z. A production `tauri build` has no Vite
 * proxy and runs on the `tauri://localhost` origin, so the path would resolve
 * against the app's own bundled `dist/` and 404. The consent policy resolves
 * it via `mediaUrl()` but withholds a media DOM source until the reader clicks.
 *
 * `MEDIA_BASE` is captured at module-eval time (and is "" under vitest, which
 * runs with `import.meta.env.DEV`), so these cases need a re-imported module
 * graph with `@/lib/env` mocked to a remote host. `vi.stubEnv` does NOT work
 * here — it never reaches `import.meta.env` in this setup.
 */
describe("Markdown article images against a remote media host", () => {
  const MEDIA = "https://media.example";
  let renderArticle: (source: string) => string;

  beforeAll(async () => {
    vi.doMock("@/lib/env", async () => {
      const actual = await vi.importActual<Record<string, unknown>>("@/lib/env");
      return { ...actual, MEDIA_BASE: MEDIA };
    });
    vi.resetModules();
    const mod = await import("./Markdown");
    renderArticle = (source) =>
      renderToStaticMarkup(
        <MemoryRouter>
          <mod.Markdown variant="article">{source}</mod.Markdown>
        </MemoryRouter>,
      );
  });

  afterAll(() => {
    vi.doUnmock("@/lib/env");
    vi.resetModules();
  });

  it("discloses the media host for a relative /uploadz src", () => {
    const markup = renderArticle("![](/uploadz/public/palmar/elg03269-1.webp)");

    expect(markup).not.toContain("<img");
    expect(markup).toContain('data-remote-media-host="media.example"');
  });

  it("discloses the media host for a path with no leading slash", () => {
    const markup = renderArticle("![](uploadz/public/x.webp)");

    expect(markup).not.toContain("<img");
    expect(markup).toContain('data-remote-media-host="media.example"');
  });

  it("names an already-absolute https destination", () => {
    const markup = renderArticle("![alt text](https://example.com/y.png)");

    expect(markup).not.toContain("<img");
    expect(markup).toContain('data-remote-media-host="example.com"');
  });

  it("normalizes and names a protocol-relative destination", () => {
    const markup = renderArticle("![](//cdn.example/z.png)");

    expect(markup).not.toContain("<img");
    expect(markup).toContain('data-remote-media-host="cdn.example"');
  });

  it("fails closed for a data URI", () => {
    const markup = renderArticle("![dot](data:image/png;base64,iVBORw0KGgo=)");

    expect(markup).not.toContain("<img");
    expect(markup).toContain("data-remote-media-blocked");
  });

  it("uses the same remote host consent for a relative comment image", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <Markdown variant="comment">
          {"![shot](/uploadz/public/tracker.webp)"}
        </Markdown>
      </MemoryRouter>,
    );

    expect(markup).not.toContain("<img");
    expect(markup).toContain('data-remote-media-host="zuuli.invalid"');
  });
});
