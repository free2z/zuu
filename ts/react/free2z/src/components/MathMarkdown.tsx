import ReactMarkdown from "react-markdown"
import remarkMath, { Options } from "remark-math"
import rehypeMathjaxSvg from "rehype-mathjax/svg";
import LinkIcon from '@mui/icons-material/Link';

import rehypePrism from "rehype-prism-plus"
import remarkDirective from "remark-directive"
import remarkFrontmatter from 'remark-frontmatter'
import yaml from 'js-yaml'
import rehypeSlug from 'rehype-slug'

import remarkOembed from "../lib/remark-oembed"
import {
    Box,
    IconButton,
    LinkProps,
    Stack,
    Table,
    TableCell,
    TableCellProps,
    TableHead,
    TableHeadProps,
    TableProps,
    styled,
    useTheme,
} from "@mui/material"
import MLink from "./MLink"
import MTypography from "./MTypography"
import MBlockquote from "./MBlockquote"
import CustomImage from "./CustomImage"
import Iframely from "./Iframely"

import "./MathMarkdown.css"
import { useStoreState } from "../state/persist"
import CodeCopyButton from "./CodeCopyButton";
import { ReactNode, useEffect, useMemo, useRef } from "react";
import React from "react";
import AudioVisualizer from "./AudioVisualizer";
import { toc } from "mdast-util-toc";
import { Link } from "react-router-dom";
// import remarkPollPlugin from "./RemarkPollPlugin";
// import PollComponent from "./PollComponent";
import { CustomTableRow, CustomTableBody } from "./CustomTableComponents";
import remarkGfm from "remark-gfm";
import Mermaid from "./Mermaid";
import remarkQrCodePlugin from "../lib/remark-qrcode";
import QRAddress from "./QRAddress";

// TODO: poll component
// interface DivProps {
//     className?: string;
//     'data-poll-id'?: string;
//     [key: string]: any;
// }


interface MathMarkdownProps {
    content: string,
    onLoadFrontmatter?: (data: any) => void,
    onHeadingLoad?: (data: any) => void,
}

const prismErrorHandler = (e: any) => {
    if (e.language && e.language !== 'none') {
        console.warn(`Unknown language '${e.language}' detected in code block. The code will be rendered as plain text.`);
    }
    return e.code;
};

function extractTextFromChildren(children: ReactNode): string {
    if (typeof children === 'string') {
        return children;
    }

    if (Array.isArray(children)) {
        return children.reduce((text, child) => text + extractTextFromChildren(child), '');
    }

    if (React.isValidElement(children) && children.props.children) {
        return extractTextFromChildren(children.props.children);
    }

    return '';
}

const remarkMathOptions: Options = {
    singleDollarTextMath: false,
}

const rehypePrismOptions = {
    ignoreMissing: true,
    transform: prismErrorHandler,
};

interface IframelyComponentProps {
    url: string;
}

function IframelyComponent(props: IframelyComponentProps) {
    const { url } = props;
    // Use useMemo to memoize the Iframely component
    const memoizedComponent = useMemo(() => <Iframely url={url} />, [url]);
    return memoizedComponent;
}
interface TableWrapperProps {
    children: React.ReactNode;
}

const TableWrapper: React.FC<TableWrapperProps> = ({ children }) => (
    <div style={{ overflowX: 'auto' }}>
        {children}
    </div>
);


const MarkdownHeadingWrapper = styled('div')(
    ({ theme }) => ({
        '& .md-heading-container, & .anchor-link': {
            '& .anchor-link': {
                opacity: 0,
            },
            '&:hover .anchor-link': {
                opacity: 1,
            },
        },
        '& .anchor-link:hover': {
            opacity: 1,
        },
    }),
)

const Heading = ({ level, ...props }: { id?: string, level: 1 | 2 | 3 | 4 | 5 | 6 }) => {
    const theme = useTheme()
    const Comp: any = { 1: 'h1', 2: 'h2', 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' }[level] || 'p'
    return (
        <MarkdownHeadingWrapper>
            <Stack className="md-heading-container" direction="row" position="relative" alignItems="center">
                {props.id && (
                    <Link className="anchor-link" to={`#${props.id}`} style={{ textDecoration: "none", position: "absolute", left: "-48px" }}>
                        <IconButton>
                            <LinkIcon fontSize="small" />
                        </IconButton>
                    </Link>
                )}
                <Comp {...props} style={{
                    borderBottom: theme.palette.mode === "dark" ? "1px solid #3d3d3d" : "1px solid #e8e8e8", width: "100%", paddingBottom: "4px"
                }} />
            </Stack>
        </MarkdownHeadingWrapper>
    )
}

// Custom styling forinline code
const InlineCode = styled('code')(
    ({ theme }) => ({
        backgroundColor: theme.palette.mode === "dark" ? "#262625" : "#f5f5f5",
        padding: "3px 8px",
        borderRadius: "6px",
        fontSize: "0.90rem !important",


    }),
)
// Custom styling for block code
const BlockCode = styled('code')(
    () => ({
        backgroundColor:"#000000 !important",
        position: "relative",
        padding:'0.5rem !important',    

    }),
)

const Pre = styled('pre')(
    () => ({
        borderRadius: "4px",
        margin: '0 !important',
        maxHeight: "650px !important",
        padding: "0.5rem ",
    }),
)

// Helper function to adjust scroll position
const scrollToElement = (element: HTMLElement, offset = 0) => {
    const top = element.getBoundingClientRect().top + window.scrollY + offset;
    window.scrollTo({ top, behavior: 'smooth' });
};


function MemoMarkdown(props: MathMarkdownProps) {
    const { onLoadFrontmatter, onHeadingLoad } = props
    const darkMode = useStoreState("darkmode")

    function remarkToc(options: any) {
        const settings = {
            ...options,
            // heading: (options && options.heading) || '(table[ -]of[ -])?contents?|toc',
            ordered: true,
            heading: undefined,
            tight: options && typeof options.tight === 'boolean' ? options.tight : true
        }

        /**
         * Transform.
         *
         * @param {Root} tree
         *   Tree.
         * @returns {undefined}
         *   Nothing.
         */
        return function (tree: any) {
            const result = toc(tree, settings)

            if (onHeadingLoad) {
                onHeadingLoad(result.map)
            }
        }
    }

    const frontmatterPlugin = () => (tree: any) => {
        let metadata: any = {};
        tree.children.forEach((node: any) => {
            if (node.type === 'yaml') {
                try {
                    metadata = yaml.load(node.value)
                } catch (err) { }
            }
        });
        if (onLoadFrontmatter) {
            onLoadFrontmatter(metadata)
        }
    };

    useEffect(() => {
        const handleFootnoteClick = (event: MouseEvent) => {
            const target = event.target as HTMLAnchorElement;
            if (target && target.tagName === 'A' && target.href.includes('fn')) {
                event.preventDefault();
                const id = target.getAttribute('href')?.substring(1);
                // console.log("Hello")
                if (id) {
                    const footnoteElement = document.getElementById(id);

                    if (footnoteElement) {
                        // console.log("!!!!!!!!")
                        scrollToElement(footnoteElement as HTMLElement, -100); // Adjust -20 to scroll a bit higher
                        window.history.pushState(null, '', `#${id}`);
                    }
                }
            }
        };
        document.addEventListener('click', handleFootnoteClick);

        return () => {
            document.removeEventListener('click', handleFootnoteClick);
        };
    }, []);

    const memoized = useMemo(() =>
        <ReactMarkdown
            className="math-markdown"
            children={props.content}
            remarkPlugins={[
                remarkDirective,
                // remarkPollPlugin,
                remarkOembed,
                remarkQrCodePlugin,
                // remarkParse,
                remarkGfm,
                // remarkRehype,
                [remarkMath, remarkMathOptions],
                // [remarkMermaidjs, remarkMermaidjsOptions],
                [remarkFrontmatter, [{ type: 'yaml', marker: '-' }]],
                frontmatterPlugin,
                remarkToc,
            ]}
            rehypePlugins={[
                rehypeMathjaxSvg,
                [rehypePrism, rehypePrismOptions],
                rehypeSlug,
            ]}
            // https://github.com/hajhosein/mui-markdown/blob/main/src/defaultOverrides.ts
            components={{
                // TODO: poll component
                // div: ({ node, ...props }: DivProps) => {
                //     if (props.className === 'poll' && props['data-poll-id']) {
                //         return <PollComponent pollId={props['data-poll-id']} />;
                //     }
                //     return <div {...props} />;
                // },
                pre: ({ children, className, ...props }) => {
                    if (className?.startsWith('language-')) {
                        return (
                            <Box component="div" display="flex" flexDirection="column" position="relative">
                                <CodeCopyButton code={extractTextFromChildren(children)} /> 
                                <Pre className={className} {...props}>
                                    {children}
                                </Pre>
                            </Box>
                        )
                    } else {
                        return (
                            <pre className={className} {...props}>
                                {children}
                            </pre>
                        )
                    }
                },
                h1: (props) => <Heading {...props} level={1} />,
                h2: (props) => <Heading {...props} level={2} />,
                h3: (props) => <Heading {...props} level={3} />,
                h4: (props) => <Heading {...props} level={4} />,
                h5: (props) => <Heading {...props} level={5} />,
                h6: (props) => <Heading {...props} level={6} />,
                em: MTypography("body1", "italic"),
                table: (props) => (
                    <TableWrapper>
                        <Table {...(props as TableProps)} />
                    </TableWrapper>
                ),
                thead: (props) => {
                    return <TableHead
                        {...props as TableHeadProps}
                        sx={{
                            backgroundColor: "inherit",
                        }}
                    />
                },
                tr: ({ children, node, ...props }) => (
                    <CustomTableRow node={node} darkMode={darkMode} {...props}>
                        {children}
                    </CustomTableRow>
                ),
                tbody: (props) => (
                    <CustomTableBody {...props}>
                        {props.children}
                    </CustomTableBody>
                ),
                th: ({ node, ...props }) => (
                    <TableCell
                        align="left"
                        sx={{
                            padding: "12px 16px",
                            borderBottom: "1px solid rgba(224, 224, 224, 1)",
                            backgroundColor: darkMode ? "#000000" : "#f5f5f5",
                            wordBreak: "keep-all",
                        }}
                        {...(props as TableCellProps)}
                    />
                ),
                td: (props) => (
                    <TableCell
                        {...props as TableCellProps}
                        align="left"
                        sx={{
                            padding: "12px 16px",
                            borderBottom: "1px solid rgba(224, 224, 224, 1)",
                            // whiteSpace: "nowrap",
                            wordBreak: "keep-all",
                        }}
                    />
                ),
                a: ({ node, ...props }) => <MLink {...props as LinkProps} />,
                blockquote: MBlockquote,
                // img: CustomImage,
                img: (props) => (
                    <CustomImage {...props as unknown as React.ImgHTMLAttributes<HTMLImageElement>} />
                ),
                p: MTypography("body1"),
                code({ node, className, children, ...props }) {
                    const mermaidMatch = /language-mermaid/.exec(className || '');
                    const oembedMatch = className === "oembed-display";
                    const iframeMatch = className === "iframe-display";
                    const qrCodeMatch = className === "qrcode-display";

                    let url = node?.properties?.['data-embed-url']?.toString() || '';
                    let qrCodeAddr = node?.properties?.['data-qr-code-addr']?.toString() || '';
                    const isLocal = url.startsWith('/');
                    const isAudio = /\.(mp3|ogg|wav)$/i.test(url);

                    // Handle Mermaid charts
                    if (mermaidMatch) {
                        const chartCode = extractTextFromChildren(children);
                        return <Mermaid chart={chartCode} />;
                    }

                    // Handle OEmbed and Iframe content
                    if ((oembedMatch || iframeMatch) && url) {
                        if (isLocal) {
                            url = `https://${window.location.host}${url}`;
                        }

                        // Handle local audio files with the AudioVisualizer
                        if (isAudio && isLocal) {
                            return <AudioVisualizer src={url} />;
                        }

                        // Default to rendering with IframelyComponent for other types
                        return <IframelyComponent url={url} />;
                    }

                    // Handle QRCode directive
                    if (qrCodeMatch && qrCodeAddr) {
                        return <QRAddress addr={qrCodeAddr} size={256} />;
                    }
                    if(className?.startsWith('language-')){
                        return (
                            <BlockCode className={className} {...props}>
                                {children}
                            </BlockCode>
                        );
                    }
                    return (
                        <InlineCode className={className} {...props}>
                            {children}
                        </InlineCode>
                    );
                },
            }}
        />, [props.content, darkMode])
    return memoized
}


export default function MathMarkdown(props: MathMarkdownProps) {
    const headingRef = useRef<any>({})
    useEffect(() => {
        const toc = Object.values(headingRef.current).reduce((acc: any, val: any) => {
            if (!acc.type) {
                acc = { ...val };
            } else {
                acc.children = acc.children.concat(val.children)
            }
            return acc;
        }, {})
        if (props.onLoadFrontmatter) {
            props.onLoadFrontmatter({ toc })
        }
    }, [headingRef.current])
    if (!props.content) {
        return null
    }
    // I think splitting based on this causes footnotes not to work
    // when there are embeds?
    const contentParts = props.content.split(/(::embed\[[^\]]+\])/);
    const contentWithKeys = contentParts.map((part, index) => ({ key: index, content: part }));
    return (
        <>
            {contentWithKeys.map(
                ({ key, content }) =>
                    <MemoMarkdown
                        key={key}
                        content={content}
                        onLoadFrontmatter={props.onLoadFrontmatter}
                        onHeadingLoad={(node: any) => {
                            if (!headingRef.current[key] && node) {
                                headingRef.current[key] = node
                            }
                        }}
                    />
            )}
        </>
    )
}
