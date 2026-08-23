import remarkParse from "remark-parse";
import { unified } from "unified";

const TUZI_CARD_IMAGE = "/docs/img/tuzi.svg";

type PageCardImage = {
  url: string;
  source: "featured" | "body" | "fallback";
};

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  identifier?: unknown;
  url?: unknown;
};

// ReactMarkdown uses this same remark-parse/CommonMark AST as its foundation.
// Images, references, code, HTML, escapes, and character references are all
// resolved here before the renderer's additional GFM/directive plugins run.
const markdownParser = unified().use(remarkParse);

function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const candidate = value.trim();
  const hasControlCharacter = candidate.split("").some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  // CommonMark replaces a literal NUL with U+FFFD while parsing. Treat that
  // replacement as malformed input rather than silently changing the URL.
  if (!candidate || hasControlCharacter || candidate.includes("\uFFFD")) {
    return null;
  }

  try {
    const parsed = new URL(candidate, "https://free2z.invalid");
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function visitInDocumentOrder(
  root: MarkdownNode,
  visitor: (node: MarkdownNode) => boolean | void
): void {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (visitor(node)) return;

    const children = node.children;
    if (!children) continue;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
}

export function extractFirstArticleImage(content: unknown): string | null {
  if (typeof content !== "string" || !content.trim()) {
    return null;
  }

  let tree: MarkdownNode;
  try {
    tree = markdownParser.parse(content) as MarkdownNode;
  } catch {
    return null;
  }

  const definitions = new Map<string, unknown>();
  visitInDocumentOrder(tree, (node) => {
    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      !definitions.has(node.identifier)
    ) {
      // CommonMark resolves duplicate labels to their first definition.
      definitions.set(node.identifier, node.url);
    }
  });

  let firstSafeImage: string | null = null;
  visitInDocumentOrder(tree, (node) => {
    let candidate: unknown;
    if (node.type === "image") {
      candidate = node.url;
    } else if (
      node.type === "imageReference" &&
      typeof node.identifier === "string"
    ) {
      candidate = definitions.get(node.identifier);
    } else {
      return false;
    }

    firstSafeImage = safeImageUrl(candidate);
    return firstSafeImage !== null;
  });

  return firstSafeImage;
}

export function getPageCardImage(
  featuredImageUrl: string | null | undefined,
  content: unknown
): PageCardImage {
  if (featuredImageUrl) {
    return { url: featuredImageUrl, source: "featured" };
  }

  const bodyImageUrl = extractFirstArticleImage(content);
  if (bodyImageUrl) {
    return { url: bodyImageUrl, source: "body" };
  }

  return { url: TUZI_CARD_IMAGE, source: "fallback" };
}
