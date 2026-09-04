import { visit } from "unist-util-visit";

/**
 * remark-directive plugin: rewrites `::qrcode[addr]` (leaf/text/container
 * directive) into a `<code class="qrcode-display" data-qr-code-addr="addr">`
 * node. The Markdown `code` override then renders a real QR code from the
 * already-bundled `qrcode.react`. Ported 1:1 from the free2z web renderer.
 *
 * @type {import('unified').Plugin<[], import('mdast').Root>}
 */
export default function remarkQrCodePlugin() {
  return (tree: any) => {
    visit(tree, (node: any) => {
      if (
        node.type === "textDirective" ||
        node.type === "leafDirective" ||
        node.type === "containerDirective"
      ) {
        if (node.name === "qrcode") {
          const data = node.data || (node.data = {});
          const addr = (node.children || [])
            .map((child: any) => child.value ?? "")
            .join("");

          data.hName = "code";
          data.hProperties = {
            class: "qrcode-display",
            "data-qr-code-addr": addr,
          };
        }
      }
    });
  };
}
