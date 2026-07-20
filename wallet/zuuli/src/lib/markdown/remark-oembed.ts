import { visit } from "unist-util-visit";

/**
 * remark-directive plugin: rewrites `::embed[URL]` (leaf/text/container
 * directive) into a `<code class="oembed-display" data-embed-url="URL">` node.
 * The Markdown `code` override then renders a SAFE, allowlisted embed
 * (YouTube / Vimeo iframe, native <video>/<audio>, or a plain external link) —
 * NOT the web renderer's Iframely remote-fetch path, which fights CSP and is
 * the biggest attack surface for a wallet.
 *
 * The URL-extraction logic (text / link / emphasis children) is ported from the
 * free2z web `remark-oembed` so the same authored markdown keeps working.
 *
 * @type {import('unified').Plugin<[], import('mdast').Root>}
 */
export default function remarkOembed() {
  return (tree: any) => {
    visit(tree, (node: any) => {
      if (
        node.type === "textDirective" ||
        node.type === "leafDirective" ||
        node.type === "containerDirective"
      ) {
        if (node.name === "embed") {
          const url = (node.children || [])
            .map((child: any) => {
              if (child.type === "text") {
                return child.value;
              }
              if (child.type === "link") {
                return child.url;
              }
              if (child.type === "emphasis") {
                // An underscore in a URL is parsed as emphasis; restore it so
                // filenames like `foo_bar.mp3` survive round-tripping.
                return `_${(child.children || [])
                  .map((c: any) => c.value ?? "")
                  .join("")}_`;
              }
              return "";
            })
            .join("");

          if (!url) return;

          const data = node.data || (node.data = {});
          data.hName = "code";
          data.hProperties = {
            class: "oembed-display",
            "data-embed-url": url,
          };
        }
      }
    });
  };
}
