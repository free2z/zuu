import { useEffect, useState } from "react"
import { useSearchParams } from 'react-router-dom'
import {
    Box, Divider, Link, List, Pagination, Paper, Stack, Switch, Tooltip, Typography
} from "@mui/material"
import axios from "axios";
import { useGlobalState } from "../state/global";
import MySubscriberRow from "./MySubscriberRow";
import { FeaturedImage } from "./PageRenderer";
import TransitionLink from "./TransitionLink";


export interface SimpleCreator {
    username: string,
    avatar_image: FeaturedImage | null,
    p2paddr: string,
}


export interface Subscription {
    star: SimpleCreator,
    fan: SimpleCreator,
    max_price: number,
    expires: string,
}

interface PageQuery {
    page: number
    sort: "expires" | "-max_price"
}

function getPQfromSP(sp: URLSearchParams): PageQuery {
    return {
        page: parseInt(sp.get("page") || "1"),
        sort: sp.get("sort") || "-max_price",
    } as PageQuery
}


export default function MySubscribers() {
    const [subscribers, setSubscribers] = useState([] as Subscription[])
    const [snack, setSnack] = useGlobalState('snackbar')
    const [loading, setLoading] = useGlobalState('loading')
    const [searchParams, setSearchParams] = useSearchParams()
    const [pageQuery, setPageQuery] = useState(getPQfromSP(searchParams))
    const [count, setCount] = useState(13)
    const [checked, setChecked] = useState(false)
    const [loaded, setLoaded] = useState(false)

    function handleChangePage(
        event: React.ChangeEvent<unknown>,
        page: number
    ): void {
        const query = {
            ...pageQuery,
            page: page,
        }
        setPageQuery(query)
    }

    useEffect(() => {
        setLoading(true)
        axios.get(`/api/tuzis/my-subscribers?page=${pageQuery.page}&ordering=${pageQuery.sort}`)
            .then(response => {
                setSubscribers(response.data.results)
                setCount(response.data.count)
                // FOUC
                setTimeout(() => setLoading(false), 1)
                setLoaded(true)
            })
            .catch(error => {
                setSnack({
                    open: true,
                    duration: undefined,
                    severity: "error",
                    message: "Failed to get your subscribers",
                })
                setLoading(false)
            });
    }, [pageQuery]);

    return (
        <Paper style={{
            padding: "3%",
            width: "100%",
        }}>

            {!loading && subscribers.length === 0 &&
                <Typography>
                    No one has subscribed to you!
                    Create a <Link to={"/edit/new"} component={TransitionLink}>New zPage</Link>!
                </Typography>
            }

            <List>
                {((!loading || loaded) && subscribers.length > 0) &&
                    <>
                        <Box
                            component="div"
                            sx={{
                                display: 'flex',
                                justifyContent: 'center',
                                alignItems: 'center'
                            }}
                        >
                            <Typography
                                variant="subtitle1"
                                style={{ marginLeft: "0.5em" }}
                            >
                                Who subscribes to you
                            </Typography>

                            <Box component="div" sx={{ ml: 'auto' }}>
                                <Tooltip title="Sort by expiration rather than max price">

                                    <Switch
                                        checked={checked}
                                        onChange={() => {
                                            setPageQuery({
                                                ...pageQuery,
                                                sort: checked ? '-max_price' : 'expires',
                                            })
                                            setChecked(!checked)
                                        }}
                                        name="sort-toggle"
                                        color="primary"
                                    />
                                </Tooltip>
                            </Box>
                        </Box>
                        <Divider
                            style={{
                                width: "100%",
                                padding: "0.25em",
                                margin: "0 auto",
                            }}
                        />
                    </>
                }
                {
                    count > 10 &&
                    <Stack
                        direction="row" alignItems="center" justifyContent="center"
                        style={{ marginTop: "0.5em" }}
                    >
                        <Pagination
                            size="small"
                            count={Math.ceil(count / 10)}
                            page={pageQuery.page}
                            onChange={handleChangePage}
                            variant="outlined"
                            color="primary"
                        />
                    </Stack>
                }
                {subscribers.map((sub, index) => {
                    return <MySubscriberRow sub={sub} index={index} key={sub.fan.username} />
                })}
            </List>
        </Paper>
    )
}