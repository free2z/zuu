import { marked } from "marked";
import hljs from "highlight.js";
import katex from "katex";
import markedFootnote from "marked-footnote";
import { gfmHeadingId } from "marked-gfm-heading-id";
import { env } from "$env/dynamic/public";
import { sanitizeMarkdownHtml } from "./markdown-sanitize";

type MathToken = {
  type: "blockMath" | "inlineMath";
  raw: string;
  text: string;
};

type DirectiveToken = {
  type: "blockDirective";
  raw: string;
  name: "embed" | "iframe" | "qrcode";
  value: string;
  block: boolean;
};

let markdownConfigured = false;
const VIDEO_EXTENSION_PATTERN = /\.(mp4|webm|mov)(?:[?#].*)?$/i;
const AUDIO_EXTENSION_PATTERN =
  /\.(mp3|ogg|wav|m4a|aac|flac|opus)(?:[?#].*)?$/i;
const FREE2Z_UPLOAD_HOST_PATTERN = /(^|\.)free2z\.(?:cash|com|net)$/i;

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
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (
    !FREE2Z_UPLOAD_HOST_PATTERN.test(parsed.hostname) ||
    !parsed.pathname.startsWith("/uploadz/")
  ) {
    return url;
  }

  return getApiUploadUrl(`${parsed.pathname}${parsed.search}${parsed.hash}`);
}

function renderVideoEmbed(url: string) {
  const extension = /\.(mp4|webm|mov)(?:[?#].*)?$/i
    .exec(url)?.[1]
    .toLowerCase();
  const mimeType =
    extension === "webm"
      ? "video/webm"
      : extension === "mov"
        ? "video/quicktime"
        : "video/mp4";
  return `<video controls class="markdown-video">
    <source src="${escapeHtmlAttribute(url)}" type="${mimeType}">
    Your browser does not support the video tag.
  </video>`;
}

function renderExternalEmbedPlaceholder(url: string) {
  return `<div class="external-embed-placeholder" data-embed-url="${escapeHtmlAttribute(url)}"></div>`;
}

function renderAudioEmbed(url: string) {
  return `<div class="audio-embed-placeholder" data-audio-url="${escapeHtmlAttribute(url)}"></div>`;
}

function renderUploadEmbed(uploadPath: string) {
  const fullUrl = getApiUploadUrl(uploadPath);

  if (AUDIO_EXTENSION_PATTERN.test(uploadPath)) {
    return renderAudioEmbed(fullUrl);
  }

  if (VIDEO_EXTENSION_PATTERN.test(uploadPath)) {
    return renderVideoEmbed(fullUrl);
  }

  return `<img src="${escapeHtmlAttribute(fullUrl)}" alt="" class="markdown-embed-image" />`;
}

function renderHttpEmbed(url: string) {
  const rewrittenUrl = rewriteFree2zUploadUrl(url);

  if (AUDIO_EXTENSION_PATTERN.test(rewrittenUrl)) {
    return renderAudioEmbed(rewrittenUrl);
  }

  if (VIDEO_EXTENSION_PATTERN.test(rewrittenUrl)) {
    return renderVideoEmbed(rewrittenUrl);
  }

  return renderExternalEmbedPlaceholder(url);
}

function renderDirective(token: DirectiveToken) {
  const value = token.value.trim();
  if (!value) return escapeHtml(token.raw);

  let rendered: string;
  if (token.name === "qrcode") {
    rendered = `<div class="qrcode-embed" data-qr-value="${escapeHtmlAttribute(value)}"></div>`;
  } else if (value.startsWith("/uploadz/")) {
    rendered = renderUploadEmbed(value);
  } else {
    const safeUrl = getSafeHttpUrl(value);
    rendered = safeUrl ? renderHttpEmbed(safeUrl) : escapeHtml(token.raw);
  }

  return token.block ? `${rendered}\n` : rendered;
}

function parseCodeInfo(info = "", lineCount = 0) {
  const language = info.trim().split(/\s+/)[0]?.toLowerCase() || "";
  const highlightedLines = new Set<number>();
  const rangeMatch = /\{([^}]+)\}/.exec(info);

  for (const part of rangeMatch?.[1]?.split(",") || []) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!range) continue;
    const start = Number(range[1]);
    const end = Number(range[2] || range[1]);
    const boundedStart = Math.max(1, start);
    const boundedEnd = Math.min(lineCount, end);
    for (let line = boundedStart; line <= boundedEnd; line += 1) {
      highlightedLines.add(line);
    }
  }

  return {
    language,
    highlightedLines,
    showLineNumbers: /(?:^|\s)showLineNumbers(?:\s|$)/i.test(info),
  };
}

function splitHighlightedCodeIntoLines(html: string) {
  const lines = [""];
  const openSpans: string[] = [];
  const tokens = html.split(/(<span\b[^>]*>|<\/span>|\n)/g);

  for (const token of tokens) {
    if (token === "\n") {
      lines[lines.length - 1] += "</span>".repeat(openSpans.length);
      lines.push(openSpans.join(""));
    } else if (token.startsWith("<span")) {
      openSpans.push(token);
      lines[lines.length - 1] += token;
    } else if (token === "</span>") {
      openSpans.pop();
      lines[lines.length - 1] += token;
    } else {
      lines[lines.length - 1] += token;
    }
  }

  return lines;
}

function renderCodeBlock(code: string, info = "") {
  const {
    language: requested,
    highlightedLines,
    showLineNumbers,
  } = parseCodeInfo(info, code.split("\n").length);
  const language =
    requested && hljs.getLanguage(requested) ? requested : "plaintext";
  const safeLanguage = language.replace(/[^a-z0-9_-]/gi, "");

  if (requested === "mermaid") {
    return `<pre><code class="language-mermaid">${escapeHtml(code)}</code></pre>\n`;
  }

  const highlightedCode =
    language === "plaintext"
      ? escapeHtml(code)
      : hljs.highlight(code, { language }).value;
  const highlighted = splitHighlightedCodeIntoLines(highlightedCode)
    .map((html, index) => {
      const lineNumber = index + 1;
      const highlightClass = highlightedLines.has(lineNumber)
        ? " code-line-highlighted"
        : "";
      return `<span class="code-line${highlightClass}">${html || " "}</span>`;
    })
    .join("");
  const lineNumberClass = showLineNumbers ? " show-line-numbers" : "";

  return `<pre><code class="hljs language-${safeLanguage}${lineNumberClass}">${highlighted}</code></pre>\n`;
}

function normalizeF2zFootnotes(content: string) {
  const lines = content.split("\n");
  const normalized: string[] = [];
  let fenceMarker: { character: string; length: number } | null = null;

  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence && !fenceMarker) {
      const marker = fence[1];
      const suffix = fence[2];
      if (marker[0] !== "`" || !suffix.includes("`")) {
        fenceMarker = { character: marker[0], length: marker.length };
      }
    } else if (fence && fenceMarker) {
      const marker = fence[1];
      if (
        marker[0] === fenceMarker.character &&
        marker.length >= fenceMarker.length &&
        !fence[2].trim()
      ) {
        fenceMarker = null;
      }
    }

    // The reference zpage places its definition directly after the reference.
    // marked-footnote follows CommonMark block boundaries, so make that common
    // classic-f2z shape explicit without changing examples inside code fences.
    if (
      !fenceMarker &&
      /^ {0,3}\[\^[^\]]+\]:/.test(line) &&
      normalized.at(-1)?.trim()
    ) {
      normalized.push("");
    }

    normalized.push(line);
  }

  return normalized.join("\n");
}

function stripLeadingFrontmatter(content: string) {
  const match =
    /^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(
      content,
    );
  return match ? content.slice(match[0].length) : content;
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

  renderer.code = function ({ text, lang }) {
    return renderCodeBlock(text, lang || "");
  };

  // Match classic react-markdown behavior: author-supplied raw HTML is shown
  // as text, not interpreted as DOM. Generated f2z directive HTML is emitted
  // by extension renderers and is unaffected by this renderer.
  renderer.html = function ({ text }) {
    return escapeHtml(text);
  };

  renderer.image = function ({ href, title, text }) {
    if (href && href.startsWith("/uploadz/")) {
      href = getApiUploadUrl(href);
    } else if (href) {
      href = rewriteFree2zUploadUrl(href);
    }

    const titleAttr = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
    return `<img src="${escapeHtmlAttribute(href)}" alt="${escapeHtmlAttribute(text)}"${titleAttr} />`;
  };

  marked.use({
    extensions: [
      {
        name: "blockDirective",
        level: "block",
        tokenizer(src) {
          const match =
            /^ {0,3}::(embed|iframe|qrcode)\[([^\]\n]+)\][ \t]*(?:\n|$)/i.exec(
              src,
            );
          if (!match) return undefined;
          return {
            type: "blockDirective",
            raw: match[0],
            name: match[1].toLowerCase(),
            value: match[2],
            block: true,
          } as DirectiveToken;
        },
        renderer(token) {
          return renderDirective(token as DirectiveToken);
        },
      },
      {
        name: "blockMath",
        level: "block",
        tokenizer(src) {
          const rules = [
            /^(?: {0,3})\$\$[ \t]*\n([\s\S]+?)\n\$\$[ \t]*(?:\n|$)/,
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
          const match = /(?:\$\$|\\\()/.exec(src);
          return match?.index;
        },
        tokenizer(src) {
          const dollarMatch =
            /^\$\$((?:\\.|[^\\$\n]|\$(?!\$))+?)\$\$(?!\$)/.exec(src);
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

  marked.use(markedFootnote());
  marked.use(gfmHeadingId());

  markdownConfigured = true;
}

function renderMarkdown(content: string): string {
  if (!content) return "";

  try {
    configureMarkdown();

    const result = marked(
      normalizeF2zFootnotes(stripLeadingFrontmatter(content)),
    );

    if (typeof result === "string") {
      return sanitizeMarkdownHtml(result);
    }

    console.warn("Async markdown processing not yet supported");
    return sanitizeMarkdownHtml(content);
  } catch (error) {
    console.error("Error processing markdown:", error);
    return escapeHtml(content);
  }
}

export function processMarkdown(content: string): string {
  return renderMarkdown(content);
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
    const htmlContent = processMarkdown(content)
      .replace(
        /<section\b[^>]*class="[^"]*\bfootnotes\b[^"]*"[^>]*>[\s\S]*<\/section>\s*$/i,
        "",
      )
      .replace(
        /<sup>\s*<a\b(?=[^>]*\bdata-footnote-ref\b)[^>]*>[\s\S]*?<\/a>\s*<\/sup>/gi,
        "",
      );
    const textContent = htmlContent
      .replace(/<[^>]*>/g, "")
      .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
      .replace(/&#x([\da-f]+);/gi, (_, value) =>
        String.fromCodePoint(Number.parseInt(value, 16)),
      )
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
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
