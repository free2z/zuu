/**
 * Plain legal documents link only to each other (allowlist.js) and mailto:.
 * Every other link -- an excluded legal document, the docs site,
 * free2z.cash, a third party -- becomes its text, so a page an SDK app opens
 * cannot lead toward a purchase. Covers Markdown links and references, raw
 * HTML <a>/<area>, and MDX <a>/<area>/<Link> elements. Runs before Docusaurus resolves
 * `./NN-name.md` links into routes.
 */
const ALLOWED = require("./allowlist");

const SIBLING = /^\.\/([0-9]{2}-[a-z0-9-]+\.md)(#[^\s]*)?$/;

function keep(url) {
  if (typeof url !== "string") return false;
  if (url.startsWith("mailto:") || url.startsWith("#")) return true;
  const match = url.match(SIBLING);
  return Boolean(match && ALLOWED.includes(match[1]));
}

function jsxHref(node) {
  for (const attribute of node.attributes || []) {
    if (
      attribute.type === "mdxJsxAttribute" &&
      (attribute.name === "href" || attribute.name === "to")
    ) {
      return typeof attribute.value === "string" ? attribute.value : null;
    }
  }
  return null;
}

/** Raw HTML: drop <a …> and </a> tags whose target is not kept. */
function unlinkHtml(value) {
  return value
    .replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (whole, _quote, href, text) => (keep(href) ? whole : text))
    // <area> (an image-map link) has no text to keep.
    .replace(/<area\b[^>]*>/gi, (tag) => {
      const href = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
      return href !== undefined && keep(href) ? tag : "";
    })
    // An <a> with no href (or one this pattern could not read) is dropped;
    // a stray </a> left behind is inert.
    .replace(/<a\b(?![^>]*\bhref\s*=\s*["'])[^>]*>/gi, "");
}

function unlink(node) {
  if (!node || !Array.isArray(node.children)) return;
  node.children = node.children.flatMap((child) => {
    unlink(child);
    if (child.type === "link" && !keep(child.url)) return child.children;
    if (child.type === "linkReference") return child.children;
    if (
      (child.type === "mdxJsxTextElement" || child.type === "mdxJsxFlowElement") &&
      (child.name === "a" || child.name === "area" || child.name === "Link") &&
      !keep(jsxHref(child))
    ) {
      return child.children || [];
    }
    if (child.type === "html" && typeof child.value === "string") {
      return [{ ...child, value: unlinkHtml(child.value) }];
    }
    return [child];
  });
}

module.exports = function remarkLegalLinks() {
  return (tree) => unlink(tree);
};
module.exports.keep = keep;
module.exports.unlink = unlink;
