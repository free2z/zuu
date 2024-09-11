import { visit } from 'unist-util-visit'

/** @type {import('unified').Plugin<[], import('mdast').Root>} */
export default function remarkOembed() {
    return (tree: any, file: any) => {
        visit(tree, (node: any) => {
            if (
                node.type === 'textDirective' ||
                node.type === 'leafDirective' ||
                node.type === 'containerDirective'
            ) {
                if (node.name === 'embed') {
                    // console.log("NODE--->", node)
                    // const url = (node.children && node.children.length > 0 && node.children[0].value)
                    // console.log("URL", url)

                    const url = node.children.map((child: any) => {
                        if (child.type === 'text') {
                            return child.value;
                        } else if (child.type === 'link') {
                            return child.url;
                        } else if (child.type === 'emphasis') {
                            // nasty nasty nasty -
                            // /uploadz/public/JuniorF95903844/01_-_QUE_AMOR_É_ESSE_-_Tarcísio_do_Acordeon_O7LJoph.mp3
                            return `_${child.children.map((c: any) => c.value).join('')}_`;
                        }
                        return '';
                    }).join('');

                    // console.log("URL--->", url)

                    if (!url) return

                    // console.log(url)

                    const data = node.data || (node.data = {})
                    // const attributes = node.attributes || {}
                    // const id = attributes.id
                    // console.log(data, attributes, id)

                    // if (node.type === 'textDirective') file.fail('Text directives for `youtube` not supported', node)
                    // if (!id) file.fail('Missing video id', node)

                    data.hName = 'code'
                    data.hProperties = {
                        class: "oembed-display",
                        "data-embed-url": url,
                    }
                    // data.hProperties = {
                    //     src: 'https://www.youtube.com/embed/' + id,
                    //     width: 200,
                    //     height: 200,
                    //     frameBorder: 0,
                    //     allow: 'picture-in-picture',
                    //     allowFullScreen: true
                    // }
                } else if (node.name === "iframe") {
                    const url = (node.children && node.children.length > 0 && node.children[0].value)
                    if (!url) return
                    const data = node.data || (node.data = {})
                    data.hName = 'code'
                    data.hProperties = {
                        class: "iframe-display",
                        "data-embed-url": url,
                    }
                }
            }
        })
    }
}
