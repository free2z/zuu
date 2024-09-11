import React, { ReactNode, useEffect, useState } from "react"
import {
    Badge,
    Box,
    Divider,
    Grid,
    Pagination,
    Stack,
    styled,
    useMediaQuery,
} from "@mui/material"
import axios from "axios"
import { useSearchParams } from "react-router-dom"

import { PageInterface } from "./PageRenderer"

import { useGlobalState } from "../state/global"
import PageListRow2 from "./PageListRow2"
import { Tag } from "./TagFilterMultiSelect"
import {
    SearchField,
    SearchFilterModal,
    SuggestedSearchFiltersRow,
} from "./FindSearchFilter"

export const StyledBadge = styled(Badge)(({ theme }) => ({
    "& .MuiBadge-badge": {
        // left: -20,
        // top: 20,
        border: `2px solid ${theme.palette.background.paper}`,
        // padding: '0 4px',
    },
}))

export interface PageQuery {
    search: string
    page: number
    showUnfunded: boolean
    showFunded: boolean
    noShowUnverified: boolean
    // categories: string[]
    tags: Tag[]
    // sort: "-updated_at" | "-f2z_score" | "-total" | "-created_at"
    sort: string
    mine: boolean
}

function getPQfromSP(
    sp: URLSearchParams,
    mine: boolean,
    username: string | undefined
): PageQuery {
    // TODO: test tags with back button
    // for back button!!
    let inittags = [] as Tag[]
    let tags = sp.get("tags")
    if (typeof tags == "string") {
        inittags = tags.split(",").map((t) => {
            return { name: t } as Tag
        })
    }
    return {
        search: sp.get("search") || "",
        page: parseInt(sp.get("page") || "1"),
        // categories: initcategories,
        tags: inittags,
        showFunded: !(sp.get("funded") === "0"),
        showUnfunded: !(sp.get("unfunded") === "0"),
        noShowUnverified: sp.get("unverified") === "0",
        sort: sp.get("ordering") || "",
        // sort: sp.get("ordering") || "-updated_at",
        mine: mine,
        username: username,
    } as PageQuery
}

export interface FindProps {
    // limit to just the request.user - owned pages
    mine: boolean
    username?: string
}

const GridContainer = ({ children, sx, isFindPage }: { children: ReactNode, sx?: any, isFindPage: boolean }) => (
    <Grid
        container
        spacing={0}
        direction="row"
        alignItems="center"
        textAlign="center"
        justifyContent="center"
        sx={{ px: '16px', ...sx }}
    >
        {isFindPage ? (
            <Grid item container xs={12} sm={11} md={10} lg={8} xl={7}>
                {children}
            </Grid>
        ) : (
            <Grid item container xs={12}>
                {children}
            </Grid>
        )}
    </Grid>
)


export default function Find(props: FindProps) {
    const isFindPage = !(props.username || props.mine)
    const [loading, setLoading] = useGlobalState("loading")
    const [pages, setPages] = useState([{} as PageInterface])
    const [searchParams, setSearchParams] = useSearchParams()
    // console.log("SEARCHPARAMS", Boolean(searchParams.toString()))
    // const [showAdvanced, setShowAdvanced] = useState(Boolean(searchParams.toString()))
    // const [showAdvanced, setShowAdvanced] = useState(true)
    const [showAdvanced, setShowAdvanced] = useState(false)
    const [isShowingAdvancedFilter, setIsShowingAdvancedFilter] = useState(false);
    const [count, setCount] = useState(0)
    const [pageQuery, setPageQuery] = useState(getPQfromSP(searchParams, props.mine, props.username))
    const isXS = useMediaQuery('(max-width:399px)')

    function setParams(q: PageQuery) {
        // console.log("setParams", props)
        let params = `search=${encodeURIComponent(q.search)}&page=${q.page}`
        if (props.mine) {
            // console.log("MINE")
            params += "&mine=1"
        }
        if (props.username) {
            params += `&username=${props.username}`
        }
        if (!q.showUnfunded) {
            params += `&unfunded=0`
        }
        if (!q.showFunded) {
            params += `&funded=0`
        }
        if (q.noShowUnverified) {
            params += `&unverified=0`
        }
        // if (q.categories.length > 0) {
        //     params += `&categories=${q.categories.join(",")}`
        // }
        if (q.tags?.length > 0) {
            // console.log("SETTING TAGS PARAM")
            // setShowAdvanced(true)
            params += `&tags=${q.tags.map(tag => tag.name).join(",")}`
        }
        if (q.sort) {
            params += `&ordering=${q.sort}`
        }
        // console.log("SETTING SEARCH PARAMS", params)
        setSearchParams(params)
    }

    function submit(
        sp: URLSearchParams
    ): Promise<PageInterface[] | [PageInterface]> {
        // TODO ... FOUC?
        setPages([])
        // sort of weird that we block the whole page now ... :/
        // if (!props.mine && !props.username) {}
        setLoading(true)
        // TODO: hack! this is getting too complicated :/
        // but, it's ok ;9
        if (sp.toString() === "") {
            if (props.mine) {
                // https://nodejs.org/api/url.html#class-urlsearchparams
                sp.append("mine", "1")
            } else if (props.username) {
                sp.append("username", props.username)
            }
        }
        // If you're gonna be dumb, you gotta be tough.
        if (props.username) {
            sp.set("username", props.username)
        }
        if (!sp.get('ordering')) {
            sp.set('ordering', '-updated_at');
        }
        // console.log("ABOUT TO CALL", props, sp.toString())
        return axios.get(`/api/zpage/?${sp}`).then((res) => {
            // console.log("setting zpages!", res)
            setPages(res.data.results.map((r: any) => {
                return {
                    ...r,
                    tags: r.tags.map((t: string) => {
                        return { name: t }
                    }),
                }
            }))
            setCount(res.data.count)
            // TODO: then?
            // setLoading(false)
            return Promise.resolve(pages)
        }).then((res) => {
            setLoading(false)
            return res
        })
        // TODO: catch
    }

    // let search = ""
    const [search, setSearch] = useState(searchParams.get("search") || "")

    function handleChangePage(
        event: React.ChangeEvent<unknown>,
        page: number
    ): void {
        const query = {
            ...pageQuery,
            page: page,
        }
        setParams(query)
    }

    useEffect(() => {
        // console.log("useEffect", searchParams)
        // searchParams["mine"]
        submit(searchParams).then(() => {
            // console.log("SUBMIT THEN")
            let query = getPQfromSP(searchParams, props.mine, props.username)
            setPageQuery({
                ...query,
            })
            setSearch(searchParams.get("search") || "")
            // Navigate `to` ?tags=
            if (
                searchParams.get("tags") ||
                // no need to show advanced if we have ordering :shrug: REWRITE
                // searchParams.get("ordering") ||
                searchParams.get('unverified')
            ) {
                // setShowAdvanced(true)
            }
        })
    }, [searchParams, props.username])


    // if we are already showing all of the creators' pages then we don't
    // need search -
    // no search, is username version and count not greater than 10
    // console.log(searchParams.toString(), props.username, count)
    const noSearch = searchParams.toString() == `username=${props.username}` &&
        props.username && count <= 10

    return (
        <Box component="div"
            sx={{
                maxWidth: '100vw',
                // width: '100%',
                // minWidth: '100%',
            }}
        >
            <Box component="div" sx={{ marginTop: props.username || props.mine ? '0' : '3em' }} />
            <GridContainer isFindPage={isFindPage}>
                <SearchFilterModal
                    open={showAdvanced}
                    handleExit={() => setShowAdvanced(false)}
                    pageQuery={pageQuery}
                    setParams={setParams}
                    initialValues={pageQuery}
                />
                {/* Controls */}
                {!noSearch &&
                    <Grid container
                        sx={{ pt: '24px', pb: '12px' }}
                    >
                        <Grid item xs={12}>
                            <Stack direction="row" alignItems="center" justifyContent="center">
                                <SearchField {...{ search, setSearch, setParams, pageQuery }} />
                            </Stack>
                        </Grid>
                    </Grid>
                }
                <Box
                    component="div"
                    sx={{
                        display: "flex",
                        justifyContent: "space-between",
                        flex: 1,
                        maxWidth: '100%',
                    }}
                >
                    <SuggestedSearchFiltersRow
                        pageQuery={pageQuery}
                        setParams={setParams}
                        setIsShowingAdvancedFilter={setIsShowingAdvancedFilter}
                    />
                </Box>
            </GridContainer>
            <Stack sx={{ position: 'relative' }}>
                {isShowingAdvancedFilter && <Box component="div" sx={{
                    backdropFilter: 'blur(16px)',
                    position: 'absolute',
                    background: (!props.username && !props.mine) ? 'rgba(0,0,0,0.5)' : undefined,
                    width: '100%',
                    height: '100%',
                    top: 0, left: 0,
                    zIndex: 99,
                }} />}
                <GridContainer isFindPage={isFindPage}>
                    {/* Pagination */}
                    {
                        count > 10 && (
                            <>
                                <Grid
                                    item
                                    container
                                    textAlign="center"
                                    alignContent="center"
                                    // align
                                    alignItems="center"
                                    direction="column"
                                    // spacing={3}
                                    style={{
                                        margin: "1em 0",
                                    }}
                                    xs={12}
                                >
                                    <Pagination
                                        size={isXS ? "small" : "medium"}
                                        // TODO: hardcoding breakds
                                        count={Math.ceil(count / 10)}
                                        page={pageQuery.page}
                                        onChange={handleChangePage}
                                        variant="outlined"
                                        color="primary"
                                    />
                                </Grid>
                                <Grid item xs={12}>
                                    <Divider
                                        variant="fullWidth"
                                    />
                                </Grid>
                            </>
                        )
                    }
                </GridContainer>
                <GridContainer
                    sx={{ px: ['0px', '16px'] }}
                    isFindPage={isFindPage}
                >
                    {
                        !loading &&
                        pages.map((page, i) => {
                            return (
                                <Grid item xs={12}
                                    key={i}
                                >
                                    <PageListRow2 {...page} mine={props.mine} />
                                </Grid>
                            )
                        })
                    }
                </GridContainer>
                <GridContainer isFindPage={isFindPage}>
                    {/* Under pagination */}
                    {
                        !loading && count > 10 &&
                        <Grid
                            item
                            container
                            textAlign="center"
                            alignContent="center"
                            // align
                            alignItems="center"
                            direction="column"
                            // spacing={3}
                            style={{
                                margin: "1em 0",
                            }}
                            xs={12}
                        >
                            <Pagination
                                size={isXS ? "small" : "medium"}
                                // TODO: hardcoding breakds
                                count={Math.ceil(count / 10)}
                                page={pageQuery.page}
                                onChange={handleChangePage}
                                variant="outlined"
                                color="primary"
                            />
                        </Grid>
                    }
                </GridContainer>
            </Stack>
        </Box>
    )
}
