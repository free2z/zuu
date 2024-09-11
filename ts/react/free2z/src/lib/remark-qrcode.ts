import { visit } from 'unist-util-visit';

/** @type {import('unified').Plugin<[], import('mdast').Root>} */
export default function remarkQrCodePlugin() {
    return (tree: any) => {
        visit(tree, (node) => {
            if (
                node.type === 'textDirective' ||
                node.type === 'leafDirective' ||
                node.type === 'containerDirective'
            ) {
                if (node.name === 'qrcode') {
                    const data = node.data || (node.data = {});
                    const addr = node.children.map((child: any) => child.value).join('');

                    data.hName = 'code';
                    data.hProperties = {
                        class: 'qrcode-display',
                        'data-qr-code-addr': addr,
                    };
                }
            }
        });
    };
}
