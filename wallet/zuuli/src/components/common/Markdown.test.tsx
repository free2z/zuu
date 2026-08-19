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
  it("renders a real <img> for the trusted article variant", () => {
    // Regression: the `components` map used to carry `img: undefined` for the
    // article variant. react-markdown resolves overrides by KEY PRESENCE, so
    // the element type became `undefined`, React threw "Element type is
    // invalid", the ErrorBoundary caught it, and every article containing an
    // image rendered as raw markdown source. See issue #319.
    const markup = render(IMAGE, "article");

    expect(markup).toContain("<img");
    expect(markup).toContain('src="https://example.com/y.png"');
    expect(markup).toContain('alt="alt text"');
    expectNoErrorFallback(markup);
  });

  it("degrades an image to a plain link for the untrusted comment variant", () => {
    // Privacy: an untrusted comment must never auto-load a remote image, which
    // would beacon the reader's IP to an attacker-chosen host on render.
    const markup = render(IMAGE, "comment");

    expect(markup).not.toContain("<img");
    expect(markup).toContain('href="https://example.com/y.png"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("alt text");
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

    expect(markup).toContain('src="/uploadz/public/palmar/elg03269-1.webp"');
  });
});

describe("Markdown links", () => {
  it("marks genuine inline prose links for the narrow touch-target exemption", () => {
    const markup = render("Read [the guide](/articles/guide).", "article");

    expect(markup).toContain('data-touch-target-exempt="inline-text"');
    expect(markup).toContain('href="/articles/guide"');
    expect(markup).toContain(">the guide</a>");
  });
});

/**
 * free2z stores article bodies with ORIGIN-RELATIVE upload paths, e.g.
 * `![](/uploadz/public/palmar/elg03269-1.webp)`. Those only resolve when the
 * document itself is served from free2z. A production `tauri build` has no Vite
 * proxy and runs on the `tauri://localhost` origin, so the path would resolve
 * against the app's own bundled `dist/` and 404. The article `img` renderer
 * absolutizes it via `mediaUrl()`.
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

  it("absolutizes a relative /uploadz src against the media host", () => {
    const markup = renderArticle("![](/uploadz/public/palmar/elg03269-1.webp)");

    expect(markup).toContain(
      `src="${MEDIA}/uploadz/public/palmar/elg03269-1.webp"`,
    );
    // Exactly one slash between host and path — no `https://media.example//…`.
    expect(markup).not.toContain(`${MEDIA}//uploadz`);
  });

  it("absolutizes a path with no leading slash", () => {
    const markup = renderArticle("![](uploadz/public/x.webp)");

    expect(markup).toContain(`src="${MEDIA}/uploadz/public/x.webp"`);
  });

  it("leaves an already-absolute https src untouched", () => {
    const markup = renderArticle("![alt text](https://example.com/y.png)");

    expect(markup).toContain('src="https://example.com/y.png"');
    expect(markup).not.toContain(MEDIA);
  });

  it("leaves a protocol-relative src untouched", () => {
    // `//cdn.example/z.png` is already absolute w.r.t. the scheme; prefixing it
    // would produce `https://media.example//cdn.example/z.png`.
    const markup = renderArticle("![](//cdn.example/z.png)");

    expect(markup).toContain('src="//cdn.example/z.png"');
    expect(markup).not.toContain(MEDIA);
  });

  it("does not corrupt a data: URI into a media-host path", () => {
    // react-markdown's `defaultUrlTransform` blocks non-http(s) protocols, so a
    // `data:` image arrives here already emptied. Whatever it becomes, it must
    // never turn into `https://media.example/data:image/...` — and an empty
    // `src=""` (which browsers resolve to the current document URL) must not
    // survive either.
    const markup = renderArticle("![dot](data:image/png;base64,iVBORw0KGgo=)");

    expect(markup).toContain("<img");
    expect(markup).not.toContain(`${MEDIA}/data:`);
    expect(markup).not.toContain(`${MEDIA}/image/png`);
    expect(markup).not.toContain('src=""');
  });

  it("still degrades a relative comment image to a plain link", () => {
    // Privacy guard: absolutizing article images must NOT make untrusted
    // comment images auto-load. A relative comment src stays a link.
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <Markdown variant="comment">
          {"![shot](/uploadz/public/tracker.webp)"}
        </Markdown>
      </MemoryRouter>,
    );

    expect(markup).not.toContain("<img");
    expect(markup).toContain('href="/uploadz/public/tracker.webp"');
    expect(markup).toContain("shot");
  });
});
