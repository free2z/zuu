
import {
    Chip,
    Divider,
    Grid,
    Paper,
    Stack,
} from "@mui/material"
import PageMetaFund from "./PageMetaFund"
import MathMarkdown from "./MathMarkdown"
import MakePageComment from "./MakePageComment"
import { PageComment } from "../PageDetail"
import DisplayComments from "./DisplayComments"
import DisplayThreadedComments from "./DisplayThreadedComments"
import CommentForm from "./CommentForm"
import { useRef, useState } from "react"
import { PublicCreator } from "../CreatorDetail"
import PageHeader from "./PageHeader"
import UpDownPage from "./UpDownPage"
import { Tag } from "./TagFilterMultiSelect"
import PageTags from "./PageTags"
import { FileMetadata } from "./DragDropFiles"
import { Moment } from "moment"
import SeriesCarousel from "./SeriesCarousel"
import { useLocation } from "react-router-dom"
import { useGlobalState } from "../state/global"
import TableOfContents from "./markdown/TableOfContents";

export interface ViewedTransactionInterface {
    txid: string,
    viewing_key: string,
    address: string,
    amount: string,
    memo: string,
    block_height: number,
    block_time: number,
}

export interface FeaturedImage extends FileMetadata {
    thumbnail: string
}

export interface PageInterface {
    creator: PublicCreator
    get_url: string
    vanity: string
    title: string
    content: string
    description: string
    // category: string
    tags: Tag[]
    free2zaddr: string
    p2paddr: string
    featured_image?: FeaturedImage | null
    is_verified: boolean
    is_published: boolean
    is_subscriber_only: boolean
    total: string
    f2z_score: string
    created_at: string
    updated_at: string
    comments: PageComment[]
    publish_at?: Moment | null
}

interface PageDetailProps {
    page: PageInterface
}

export function formatDate(date: string): string {
    const d = new Date(date)
    // hrm
    return d.toLocaleDateString("en-us", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
    })
}

const scrollIntoViewWithOffset = (id: any, offset: number) => {
    /* 😭😭😭😭😭😭😭 */
    setTimeout(() => {
        const element = document.getElementById(id);
        if (!element?.getBoundingClientRect()?.top) { return; }
        const y = element?.getBoundingClientRect()?.top + window.scrollY + -offset;
        (typeof window !== 'undefined' ? window : undefined)?.scrollTo({ top: y, behavior: 'smooth' });
    }, 750)
}

const useScrollToLocation = () => {
    const scrolledRef = useRef(false);
    const { hash } = useLocation();
    const [loading, _] = useGlobalState("loading")
    const [loadingEmbed, setLoadingEmbed] = useGlobalState("loadingEmbed")

    if (hash && !scrolledRef.current && !loading && !loadingEmbed) {
        const id = decodeURIComponent(hash).replace('#', '');
        const element = document.getElementById(id);
        if (element) {
            scrollIntoViewWithOffset(id, 64);
            scrolledRef.current = true;
        }
    }
};

export default function PageDetail(props: PageDetailProps) {
    const { page } = props
    const [reload, setReload] = useState(0)
    const [toc, setToc] = useState<{ toc?: any }>({})

    const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
    const open = Boolean(anchorEl);

    const onLoadMetadata = (data: { toc?: any }) => {
        if (data.toc) {
            setToc({ toc: data.toc })
        }
    }

    useScrollToLocation()


    return (
        <Grid
            container
            spacing={0}
            direction="row"
            alignItems="center"
            textAlign="left"
            justifyContent="center"
            style={{
                minHeight: "30vh",
                marginBottom: "3em",
            }}
        >
            {/* Floating Action Button */}
            <PageMetaFund {...page} />
            <PageHeader {...page} tocComponent={toc?.toc && Object.values(toc.toc).length > 0 && (
                <Stack position="absolute" right={0} bottom={0}>
                    <TableOfContents toc={toc.toc} />
                </Stack>
            )} />

            {/* if no image, make a line underneath */}
            {!page.featured_image &&
                <Grid item xs={12}>
                    <Divider
                        style={{
                            margin: "0.5em auto 1em auto",
                            // width: "55%",
                        }}
                    />
                </Grid>
            }

            <Grid item xs={12}>
                <div
                    style={{
                        width: "100%",
                        // maxWidth: "768px",
                        maxWidth: "1024px",
                        margin: "0 auto",
                        marginBottom: "3em",
                        display: "block",
                        visibility: "visible",
                        overflowWrap: "break-word",
                        padding: "0 0.2em",
                    }}
                >
                    <MathMarkdown content={page.content} onLoadFrontmatter={onLoadMetadata} />
                </div>
            </Grid>


            <Grid item xs={12}>
                <PageTags page={page} />
            </Grid>

            <Grid item xs={12}>
                <Paper elevation={1}
                    style={{
                        maxWidth: "250px",
                        padding: "1em",
                        margin: "0.5em auto 0 auto",
                    }}
                >
                    <UpDownPage page={page} noShow={false} />
                </Paper>
            </Grid>

            <Grid item xs={12}>
                <SeriesCarousel free2zaddr={page.free2zaddr} />
            </Grid>

            <Grid item xs={12}>
                <Divider style={{ margin: "1em 0" }}>
                    <Chip color="primary" label="Comment with Zcash"
                        variant="outlined"
                    />
                </Divider>
            </Grid>

            <Grid item xs={12}
                style={{
                    maxWidth: "768px",
                    margin: "0 auto",
                }}
            >
                <MakePageComment free2zaddr={page.free2zaddr} />
            </Grid>

            <Grid item xs={12}>
                {page.comments.length > 0 && (
                    <>
                        <Divider style={{ margin: "1em 0 2em 0" }}>
                            <Chip
                                color="info"
                                label="Zcash Comments"
                                variant="outlined"
                            />
                        </Divider>
                        <DisplayComments comments={page.comments} />
                    </>
                )}
            </Grid>

            {/* Comment with 2Z */}
            {page.vanity && (
                <>
                    <Grid item xs={12}>
                        <Divider style={{ margin: "1em 0" }}>
                            <Chip color="secondary" label="Comment with 2Z"
                            // variant="outlined"
                            />
                        </Divider>
                    </Grid>

                    <Grid item xs={12}>
                        <CommentForm
                            object_type="zpage"
                            object_uuid={page.free2zaddr}
                            callback={() => { setReload(Math.random()) }}
                        />
                    </Grid>
                    <Grid
                        item
                        xs={12}
                        style={{
                            overflowX: "auto",
                            marginBottom: "3em",
                        }}
                    >
                        <DisplayThreadedComments
                            object_type="zpage"
                            object_uuid={page.free2zaddr}
                            reload={reload}
                        />
                    </Grid>
                </>
            )}
        </Grid>
    )
}
