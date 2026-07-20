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

import "./markdown.css";

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

/** Extract a YouTube video id from the common URL shapes. */
function youTubeId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtu.be") return url.pathname.slice(1) || null;
  if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
    if (url.pathname.startsWith("/embed/"))
      return url.pathname.split("/")[2] || null;
    return url.searchParams.get("v");
  }
  return null;
}

/** Extract a numeric Vimeo id. */
function vimeoId(url: URL): string | null {
  if (!url.hostname.replace(/^www\./, "").endsWith("vimeo.com")) return null;
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
 */
function SafeEmbed({ url }: { url: string }) {
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

/**
 * Themed markdown renderer used by Articles and AI chat. Styled inline (no
 * tailwind-typography dependency) so it always matches the ZUULI dark theme.
 *
 * Feature parity with the free2z web renderer:
 *   • display math (`$$…$$`) via remark-math + rehype-mathjax/svg (offline SVG),
 *   • syntax highlight + opt-in line numbers via rehype-prism-plus,
 *   • mermaid diagrams (lazy-loaded), `::qrcode[addr]`, safe `::embed[URL]`,
 *   • GFM tables/footnotes, heading slugs.
 *
 * Raw HTML stays ESCAPED (react-markdown's default — no rehype-raw): a wallet
 * must never render untrusted HTML.
 */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  // Memoize on content: mathjax/mermaid/prism are expensive, and AI streaming
  // re-renders this on every token.
  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[
          remarkDirective,
          remarkOembed,
          remarkQrCodePlugin,
          remarkGfm,
          [remarkMath, { singleDollarTextMath: false }],
        ]}
        rehypePlugins={[
          rehypeMathjaxSvg,
          [rehypePrism, { ignoreMissing: true }],
          rehypeSlug,
        ]}
        components={{
          a: MarkdownLink,
          pre: CodeBlock,
          table: ({ node, ...props }) => (
            <div className="overflow-x-auto">
              <table {...props} />
            </div>
          ),
          code({ node, className: codeClass, children: codeChildren, ...rest }) {
            // Directive- and fence-driven custom renderers.
            if (/language-mermaid/.test(codeClass || "")) {
              return <Mermaid chart={childrenToText(codeChildren)} />;
            }
            if (codeClass === "qrcode-display") {
              const addr =
                node?.properties?.["dataQrCodeAddr"]?.toString() ||
                node?.properties?.["data-qr-code-addr"]?.toString() ||
                "";
              if (addr) {
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
              if (url) return <SafeEmbed url={url} />;
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
    [children],
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
      {rendered}
    </div>
  );
}
