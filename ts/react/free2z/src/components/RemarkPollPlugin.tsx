import { visit } from 'unist-util-visit';
import { Plugin } from 'unified';
import { Root, Node } from 'mdast';
import { Data } from 'unist';

// Define the DirectiveNode interface
interface DirectiveNode extends Node {
    type: 'textDirective' | 'leafDirective' | 'containerDirective';
    name: string;
    attributes: Record<string, string>;
    data?: {
        hName?: string;
        hProperties?: Record<string, string>;
    } & Data;
}

// Type guard to check if a node is a DirectiveNode
function isDirectiveNode(node: Node): node is DirectiveNode {
    return (
        node.type === 'textDirective' ||
        node.type === 'leafDirective' ||
        node.type === 'containerDirective'
    );
}

// Define the custom poll plugin
const remarkPollPlugin: Plugin<[], Root> = () => (tree: Root) => {
    visit(tree, 'textDirective', (node: any) => {
        if (isDirectiveNode(node) && node.name === 'poll') {
            const data = node.data || (node.data = {});
            const attributes = node.attributes || {};

            data.hName = 'div';
            data.hProperties = { className: 'poll', 'data-poll-id': attributes.id };
        }
    });
};

export default remarkPollPlugin;
