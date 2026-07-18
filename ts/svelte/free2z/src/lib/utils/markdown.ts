import { marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";
import katex from "katex";
import { env } from "$env/dynamic/public";
import { isExternalEmbedDomain } from "./embed-domains";

type MathToken = {
  type: "blockMath" | "inlineMath";
  raw: string;
  text: string;
};

let markdownConfigured = false;
const VIDEO_EXTENSION_PATTERN = /\.(mp4|webm|ogg|mov)$/i;

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  shell: "Shell",
  sh: "Shell",
  zsh: "Zsh",
  js: "JavaScript",
  jsx: "JSX",
  ts: "TypeScript",
  tsx: "TSX",
  json: "JSON",
  yml: "YAML",
  md: "Markdown",
  py: "Python",
  rb: "Ruby",
  rs: "Rust",
  csharp: "C#",
  cpp: "C++",
  objc: "Objective-C",
  plaintext: "Plain text",
  text: "Plain text",
};

function renderMath(text: string, displayMode: boolean) {
  return katex.renderToString(text, {
    displayMode,
    output: "html",
    strict: "ignore",
    throwOnError: false,
  });
}

function escapeHtml(content: string) {
  return content
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(content?: string | null) {
  return String(content ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function getSafeHttpUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function getApiUploadUrl(path: string) {
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";
  return `${apiBase}${path}`;
}

function rewriteFree2zUploadUrl(url: string) {
  if (!url.includes("free2z.cash/uploadz/")) {
    return url;
  }

  return getApiUploadUrl(url.substring(url.indexOf("/uploadz/")));
}

function renderVideoEmbed(url: string) {
  return `<video controls class="markdown-video">
    <source src="${escapeHtmlAttribute(url)}" type="video/mp4">
    Your browser does not support the video tag.
  </video>`;
}

function renderExternalEmbedPlaceholder(url: string) {
  return `<div class="external-embed-placeholder" data-embed-url="${escapeHtmlAttribute(url)}"></div>`;
}

function renderUploadEmbed(uploadPath: string) {
  const fullUrl = getApiUploadUrl(uploadPath);

  if (VIDEO_EXTENSION_PATTERN.test(uploadPath)) {
    return renderVideoEmbed(fullUrl);
  }

  return `<img src="${escapeHtmlAttribute(fullUrl)}" alt="" class="markdown-embed-image" />`;
}

function renderHttpEmbed(url: string) {
  if (isExternalEmbedDomain(url)) {
    return renderExternalEmbedPlaceholder(url);
  }

  if (VIDEO_EXTENSION_PATTERN.test(url)) {
    return renderVideoEmbed(rewriteFree2zUploadUrl(url));
  }

  return renderExternalEmbedPlaceholder(url);
}

function processCustomEmbeds(content: string) {
  return content.replace(/::embed\[([^\]]+)\]/gi, (match, url) => {
    const trimmedUrl = url.trim();

    if (trimmedUrl.startsWith("/uploadz/")) {
      return renderUploadEmbed(trimmedUrl);
    }

    const safeUrl = getSafeHttpUrl(trimmedUrl);

    return safeUrl ? renderHttpEmbed(safeUrl) : escapeHtml(match);
  });
}

function configureMarkdown() {
  if (markdownConfigured) {
    return;
  }

  marked.setOptions({
    breaks: true,
    gfm: true,
  });

  const renderer = new marked.Renderer();

  renderer.image = function ({ href, title, text }) {
    if (href && href.startsWith("/uploadz/")) {
      const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";
      href = `${apiBase}${href}`;
    }

    if (href && href.includes("free2z.cash/uploadz/")) {
      const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";
      const uploadPath = href.substring(href.indexOf("/uploadz/"));
      href = `${apiBase}${uploadPath}`;
    }

    const titleAttr = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
    return `<img src="${escapeHtmlAttribute(href)}" alt="${escapeHtmlAttribute(text)}"${titleAttr} />`;
  };

  marked.use(
    markedHighlight({
      langPrefix: "hljs language-",
      highlight(code, lang) {
        const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
        return hljs.highlight(code, { language }).value;
      },
    }),
  );

  marked.use({
    extensions: [
      {
        name: "blockMath",
        level: "block",
        start(src) {
          const match = /(?:\$\$|\\\[)/.exec(src);
          return match?.index;
        },
        tokenizer(src) {
          const rules = [
            /^(?: {0,3})\$\$[ \t]*\n([\s\S]+?)\n\$\$[ \t]*(?:\n|$)/,
            /^(?: {0,3})\$\$([^\n]+?)\$\$[ \t]*(?:\n|$)/,
            /^(?: {0,3})\\\[[ \t]*\n([\s\S]+?)\n\\\][ \t]*(?:\n|$)/,
            /^(?: {0,3})\\\[([^\n]+?)\\\][ \t]*(?:\n|$)/,
          ];

          for (const rule of rules) {
            const match = rule.exec(src);
            if (!match) {
              continue;
            }

            return {
              type: "blockMath",
              raw: match[0],
              text: match[1] ?? "",
            } satisfies MathToken;
          }

          return undefined;
        },
        renderer(token) {
          return `<div class="math math-block">${renderMath(
            (token as MathToken).text,
            true,
          )}</div>`;
        },
      },
      {
        name: "inlineMath",
        level: "inline",
        start(src) {
          const match = /(?:\$|\\\()/.exec(src);
          return match?.index;
        },
        tokenizer(src) {
          if (src.startsWith("$$") || src.startsWith("\\[")) {
            return undefined;
          }

          const dollarMatch = /^\$((?:\\.|[^\\$\n])+?)\$(?!\$)/.exec(src);
          if (dollarMatch) {
            const text = dollarMatch[1] ?? "";
            if (text.trim() === text && text.length > 0) {
              return {
                type: "inlineMath",
                raw: dollarMatch[0],
                text,
              } satisfies MathToken;
            }
          }

          const parenMatch = /^\\\(((?:\\.|[^\\\n])+?)\\\)/.exec(src);
          if (parenMatch) {
            return {
              type: "inlineMath",
              raw: parenMatch[0],
              text: parenMatch[1] ?? "",
            } satisfies MathToken;
          }

          return undefined;
        },
        renderer(token) {
          return renderMath((token as MathToken).text, false);
        },
      },
    ],
    renderer,
  });

  markdownConfigured = true;
}

export function processMarkdown(content: string): string {
  if (!content) return "";

  try {
    configureMarkdown();

    const processedContent = processCustomEmbeds(content);
    const result = marked(processedContent);

    if (typeof result === "string") {
      return result;
    }

    console.warn("Async markdown processing not yet supported");
    return processedContent;
  } catch (error) {
    console.error("Error processing markdown:", error);
    return content.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

export function getCodeLanguageInfo(languageClass = "") {
  const normalized = languageClass
    .replace(/^language-/, "")
    .replace(/^lang-/, "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return {
      requested: "",
      language: "plaintext",
      label: "Plain text",
      supported: false,
    };
  }

  const supported = Boolean(hljs.getLanguage(normalized));
  const language = supported ? normalized : "plaintext";
  const label =
    LANGUAGE_LABELS[normalized] ||
    LANGUAGE_LABELS[language] ||
    normalized
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());

  return {
    requested: normalized,
    language,
    label,
    supported,
  };
}

export function extractPlainText(content: string, maxLength = 160): string {
  if (!content) return "";

  try {
    const htmlContent = processMarkdown(content);
    const textContent = htmlContent
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (maxLength && textContent.length > maxLength) {
      return textContent.substring(0, maxLength).trim() + "...";
    }

    return textContent;
  } catch (error) {
    console.error("Error extracting plain text:", error);
    return content.substring(0, maxLength) + "...";
  }
}
