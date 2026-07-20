import {
  useMemo,
  useState,
  isValidElement,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import { useNavigate } from "react-router-dom";
import { Check, Copy } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { visit } from "unist-util-visit";

import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeMathjaxSvg from "rehype-mathjax/svg";
import rehypePrism from "rehype-prism-plus";
import rehypeSlug from "rehype-slug";

import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "@/lib/platform";
import { cn } from "@/lib/utils";

import remarkOembed from "@/lib/markdown/remark-oembed";
import remarkQrCodePlugin from "@/lib/markdown/remark-qrcode";
import Mermaid from "@/components/common/Mermaid";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";

import "./markdown.css";

/**
 * Rendering variants:
 *   • "article"  — trusted, creator/AI long-form content. Full rich pipeline:
 *                  auto-loading images, native video/audio embeds, QR codes,
 *                  mermaid diagrams.
 *   • "comment"  — UNTRUSTED, user-supplied comment bodies. Hardened: remote
 *                  images and media embeds degrade to plain external LINKS (no
 *                  silent network beacons that deanonymize readers by IP), and
 *                  `::qrcode` / mermaid are shown as text/code rather than a
 *                  scannable QR or rendered diagram (phishing + perf). This is
 *                  the primary render-layer privacy fix; see also the CSP note
 *                  in `src-tauri/tauri.conf.json` (intentionally NOT tightened
 *                  for images because trusted article markdown legitimately
 *                  hotlinks arbitrary hosts).
 */
export type MarkdownVariant = "article" | "comment";

/**
 * True for links that must leave the app (http/https/mailto/tel and any other
 * absolute scheme). Relative paths and in-page hashes stay inside the SPA.
 */
function isExternalHref(href: string): boolean {
  if (!href) return false;
  // Protocol-relative (`//host/…`) is external.
  if (href.startsWith("//")) return true;
  // In-app anchors / relative / query-only links are internal.
  if (href.startsWith("#") || href.startsWith("/") || href.startsWith("?"))
    return false;
  // Any `scheme:` prefix (http:, https:, mailto:, tel:, …) is external.
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/** Open an external URL out-of-app, never in the SPA's own webview. */
async function openExternal(url: string) {
  if (isTauri()) {
    // Desktop: hand off to the OS default handler via tauri-plugin-opener so
    // the wallet's own webview is never navigated away.
    try {
      await openUrl(url);
      return;
    } catch {
      // Fall through to a browser tab (also covers non-http schemes).
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Markdown anchor. Article/AI content is remote/untrusted: external links open
 * outside the app (OS browser on desktop, new tab in the browser build) and
 * always carry `rel="noopener noreferrer"`; internal links use the router so
 * the running SPA is never blown away. In-page `#` anchors (footnotes, heading
 * slugs) smooth-scroll to their target instead of routing — router navigation
 * to a hash never scrolls, which is the "footnotes don't scroll" bug.
 */
function MarkdownLink({
  href,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const navigate = useNavigate();

  // In-page anchor: scroll to the element, don't navigate.
  if (href && href.startsWith("#")) {
    return (
      <a
        {...rest}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          const id = decodeURIComponent(href.slice(1));
          document
            .getElementById(id)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      >
        {children}
      </a>
    );
  }

  if (href && isExternalHref(href)) {
    return (
      <a
        {...rest}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          e.preventDefault();
          void openExternal(href);
        }}
      >
        {children}
      </a>
    );
  }

  return (
    <a
      {...rest}
      href={href ?? "#"}
      onClick={(e) => {
        if (!href) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

/** Flatten a react-markdown children tree into its plain-text content. */
function childrenToText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join("");
  if (isValidElement(children)) {
    return childrenToText(
      (children.props as { children?: ReactNode }).children,
    );
  }
  return "";
}

/** Copy-to-clipboard button rendered on top of fenced code blocks. */
function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy code"}
      onClick={() => {
        void navigator.clipboard?.writeText(getText());
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      className="absolute right-2 top-2 z-10 inline-flex min-h-8 min-w-8 items-center justify-center rounded-md border border-border bg-card/80 p-1.5 text-muted-foreground opacity-0 backdrop-blur transition hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
    >
      {copied ? (
        <Check className="h-4 w-4 text-primary" />
      ) : (
        <Copy className="h-4 w-4" />
      )}
    </button>
  );
}

/** Fenced code block with a hover copy button (skips plain/inline `pre`). */
function CodeBlock({
  className,
  children,
  ...props
}: {
  className?: string;
  children?: ReactNode;
}) {
  if (className?.includes("language-")) {
    return (
      <div className="group relative">
        <CopyButton getText={() => childrenToText(children)} />
        <pre className={className} {...props}>
          {children}
        </pre>
      </div>
    );
  }
  return (
    <pre className={className} {...props}>
      {children}
    </pre>
  );
}

/**
 * Extract a YouTube video id from the common URL shapes. Hostnames are matched
 * EXACTLY (not `endsWith`), so a lookalike like `notyoutube.com` never slips
 * through the allowlist.
 */
function youTubeId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtu.be") return url.pathname.slice(1) || null;
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname.startsWith("/embed/"))
      return url.pathname.split("/")[2] || null;
    return url.searchParams.get("v");
  }
  return null;
}

/** Extract a numeric Vimeo id (exact-host match only). */
function vimeoId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, "");
  if (host !== "vimeo.com" && host !== "player.vimeo.com") return null;
  const m = url.pathname.match(/\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Safe, allowlisted `::embed[URL]` renderer. NO remote metadata fetch (Iframely)
 * — only known-safe, fixed-shape targets:
 *   • YouTube  → youtube-nocookie.com/embed iframe
 *   • Vimeo    → player.vimeo.com iframe
 *   • .mp4/... → native <video controls>
 *   • .mp3/... → native <audio controls>
 *   • anything else → a plain external link.
 *
 * In the "comment" (untrusted) variant, NOTHING auto-loads: every embed
 * degrades to a plain external link. Native <video>/<audio> from an arbitrary
 * attacker host would silently beacon every reader's IP on render, and even the
 * fixed YouTube/Vimeo iframes ping third parties — neither is acceptable for
 * anonymous, unmoderated comment content in a wallet.
 */
function SafeEmbed({ url, variant }: { url: string; variant: MarkdownVariant }) {
  // Untrusted comments never auto-load remote media — always a link.
  if (variant === "comment") {
    return <MarkdownLink href={url}>{url}</MarkdownLink>;
  }

  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  // Only https targets get rich embeds; everything else degrades to a link.
  if (parsed && parsed.protocol === "https:") {
    const yt = youTubeId(parsed);
    if (yt) {
      return (
        <div className="my-4 aspect-video w-full overflow-hidden rounded-lg border border-border">
          <iframe
            className="h-full w-full"
            src={`https://www.youtube-nocookie.com/embed/${yt}`}
            title="YouTube video"
            loading="lazy"
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      );
    }

    const vm = vimeoId(parsed);
    if (vm) {
      return (
        <div className="my-4 aspect-video w-full overflow-hidden rounded-lg border border-border">
          <iframe
            className="h-full w-full"
            src={`https://player.vimeo.com/video/${vm}`}
            title="Vimeo video"
            loading="lazy"
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
          />
        </div>
      );
    }

    if (/\.(mp4|webm|ogv|mov)$/i.test(parsed.pathname)) {
      return (
        <video controls className="my-4 w-full rounded-lg border border-border">
          <source src={url} />
        </video>
      );
    }

    if (/\.(mp3|ogg|wav|m4a|flac)$/i.test(parsed.pathname)) {
      return <audio controls className="my-4 w-full" src={url} />;
    }
  }

  // Fallback: a plain external link (reuses out-of-app open handling).
  return <MarkdownLink href={url}>{url}</MarkdownLink>;
}

// ── Math DoS guard (defense-in-depth) ───────────────────────────────────────
// A comment body of `$$` + `{`×400 + … + `}`×400 + `$$` makes rehype-mathjax
// recurse until it throws `RangeError: Maximum call stack size exceeded`
// SYNCHRONOUSLY inside React render. The <Markdown> ErrorBoundary is the
// primary fix (degrade to plain text), but we ALSO neutralize the expression
// before it ever reaches MathJax: any `$$…$$` / `$…$` whose source is absurdly
// long or brace-nested far past anything real math needs is converted back to a
// plain code node showing the raw TeX. Legitimate math is nowhere near these
// caps.
const MATH_MAX_LEN = 3000;
const MATH_MAX_BRACE_DEPTH = 30;

function maxBraceDepth(s: string): number {
  let depth = 0;
  let max = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") {
      depth++;
      if (depth > max) max = depth;
    } else if (ch === "}" && depth > 0) {
      depth--;
    }
  }
  return max;
}

/**
 * remark plugin (must run AFTER remark-math): defuses pathological math nodes
 * by turning them into plain `code`/`inlineCode` so rehype-mathjax never sees
 * them and cannot stack-overflow the render.
 *
 * @type {import('unified').Plugin<[], import('mdast').Root>}
 */
function remarkMathGuard() {
  return (tree: any) => {
    visit(tree, (node: any) => {
      if (node.type !== "math" && node.type !== "inlineMath") return;
      const value: string = node.value ?? "";
      if (
        value.length > MATH_MAX_LEN ||
        maxBraceDepth(value) > MATH_MAX_BRACE_DEPTH
      ) {
        node.type = node.type === "math" ? "code" : "inlineCode";
        node.lang = null;
        node.meta = null;
        // Drop any math-specific hast hints so the default code handler runs.
        if (node.data) {
          delete node.data.hName;
          delete node.data.hProperties;
        }
      }
    });
  };
}

/**
 * Themed markdown renderer used by Articles, AI chat, and comments. Styled
 * inline (no tailwind-typography dependency) so it always matches the ZUULI
 * dark theme.
 *
 * Feature parity with the free2z web renderer (article variant):
 *   • display math (`$$…$$`) via remark-math + rehype-mathjax/svg (offline SVG),
 *   • syntax highlight + opt-in line numbers via rehype-prism-plus,
 *   • mermaid diagrams (lazy-loaded), `::qrcode[addr]`, safe `::embed[URL]`,
 *   • GFM tables/footnotes, heading slugs.
 *
 * Raw HTML stays ESCAPED (react-markdown's default — no rehype-raw): a wallet
 * must never render untrusted HTML.
 *
 * The whole render is wrapped in an ErrorBoundary that degrades to the plain,
 * escaped source text — so no single body (however malicious) can throw during
 * render and unmount the surrounding page. Pass `variant="comment"` for
 * untrusted user content (see `MarkdownVariant`).
 */
export function Markdown({
  children,
  className,
  variant = "article",
}: {
  children: string;
  className?: string;
  variant?: MarkdownVariant;
}) {
  const isComment = variant === "comment";

  // Memoize on content + variant: mathjax/mermaid/prism are expensive, and AI
  // streaming re-renders this on every token.
  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[
          remarkDirective,
          remarkOembed,
          remarkQrCodePlugin,
          remarkGfm,
          [remarkMath, { singleDollarTextMath: false }],
          // AFTER remark-math so the math nodes already exist to be defused.
          remarkMathGuard,
        ]}
        rehypePlugins={[
          rehypeMathjaxSvg,
          [rehypePrism, { ignoreMissing: true }],
          rehypeSlug,
        ]}
        components={{
          a: MarkdownLink,
          pre: CodeBlock,
          // Untrusted comments: remote images become plain external links so
          // they never auto-load and beacon the reader's IP to an attacker.
          img: isComment
            ? ({ src, alt }) => (
                <MarkdownLink href={typeof src === "string" ? src : "#"}>
                  {alt || (typeof src === "string" ? src : "image")}
                </MarkdownLink>
              )
            : undefined,
          table: ({ node, ...props }) => (
            <div className="overflow-x-auto">
              <table {...props} />
            </div>
          ),
          code({ node, className: codeClass, children: codeChildren, ...rest }) {
            // Directive- and fence-driven custom renderers.
            if (/language-mermaid/.test(codeClass || "")) {
              // Comments: don't render arbitrary diagrams (perf + surface) —
              // fall through to a plain code block showing the source.
              if (!isComment) {
                return <Mermaid chart={childrenToText(codeChildren)} />;
              }
            }
            if (codeClass === "qrcode-display") {
              const addr =
                node?.properties?.["dataQrCodeAddr"]?.toString() ||
                node?.properties?.["data-qr-code-addr"]?.toString() ||
                "";
              if (addr) {
                // Untrusted comments: never render a scannable QR of an
                // attacker-chosen string inside wallet chrome (phishing aid) —
                // show the raw value as text so it's clearly user-supplied.
                if (isComment) {
                  return (
                    <code className="break-all text-xs text-muted-foreground">
                      {addr}
                    </code>
                  );
                }
                return (
                  <span className="my-4 flex flex-col items-center gap-2">
                    <span className="rounded-lg bg-white p-3">
                      <QRCodeSVG value={addr} size={256} />
                    </span>
                    <code className="break-all text-center text-xs text-muted-foreground">
                      {addr}
                    </code>
                  </span>
                );
              }
            }
            if (codeClass === "oembed-display") {
              const url =
                node?.properties?.["dataEmbedUrl"]?.toString() ||
                node?.properties?.["data-embed-url"]?.toString() ||
                "";
              if (url) return <SafeEmbed url={url} variant={variant} />;
            }

            return (
              <code className={codeClass} {...rest}>
                {codeChildren}
              </code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    ),
    [children, variant, isComment],
  );

  return (
    <div
      className={cn(
        "zuuli-markdown",
        "space-y-4 text-[15px] leading-relaxed text-foreground/90",
        "[&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:tracking-tight",
        "[&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold",
        "[&_h3]:mt-4 [&_h3]:text-lg [&_h3]:font-semibold",
        "[&_p]:leading-relaxed",
        // `text-link` (not `text-primary`): the brand violet at 65% lightness
        // only clears ~4.3:1 against card surfaces, short of WCAG AA (4.5:1)
        // for body-sized link text. `--link` is the same hue, lightened to
        // 74%, which clears AA on every surface content renders on.
        //
        // `[&_a:hover]:decoration-2` (NOT `[&_a]:hover:decoration-2`): the
        // hover pseudo-class must bind to the `a` itself inside the arbitrary
        // selector. `[&_a]:hover:decoration-2` instead compiles to
        // `.container:hover a { … }` — hovering ANYWHERE over the container
        // (e.g. the card the bio/article renders inside) thickens every link
        // at once. `[&_a:hover]:decoration-2` compiles to
        // `.container a:hover { … }`, so only the specific anchor under the
        // cursor is affected.
        "[&_a]:text-link [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:decoration-2",
        "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6",
        "[&_li]:my-1",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-primary [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-muted-foreground",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px]",
        "[&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_img]:rounded-lg [&_img]:border [&_img]:border-border",
        "[&_hr]:my-6 [&_hr]:border-border",
        // Tables: full-width, wrapped in overflow-x:auto (see `table` override),
        // muted header, padded cells, bottom borders, subtle zebra rows.
        "[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm",
        "[&_th]:border-b [&_th]:border-border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold",
        "[&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-2",
        "[&_tbody_tr:nth-child(even)]:bg-muted/30",
        className,
      )}
    >
      {/*
        Per-body error boundary: a malicious/oversized body (e.g. a MathJax
        stack overflow that slips past the guard above) degrades to its plain,
        escaped source text instead of throwing during render and taking the
        surrounding page down. `resetKeys` retries when the content changes.
      */}
      <ErrorBoundary
        resetKeys={[children, variant]}
        fallback={
          <div className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {children}
          </div>
        }
      >
        {rendered}
      </ErrorBoundary>
    </div>
  );
}
