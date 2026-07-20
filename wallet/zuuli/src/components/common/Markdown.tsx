import type { AnchorHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import { useNavigate } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "@/lib/platform";
import { cn } from "@/lib/utils";

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
 * the running SPA is never blown away.
 */
function MarkdownLink({
  href,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const navigate = useNavigate();

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

/**
 * Themed markdown renderer used by Articles and AI chat. Styled inline (no
 * tailwind-typography dependency) so it always matches the ZUULI dark theme.
 */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
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
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: MarkdownLink }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
