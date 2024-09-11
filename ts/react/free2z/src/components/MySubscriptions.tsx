import axios from "axios";
import { useState, useEffect } from "react";
import { useSearchParams } from 'react-router-dom'
import {
    Box,
    Divider,
    Link, List,
    Pagination, Paper, Stack, Switch, Tooltip, Typography
} from "@mui/material"

import { useGlobalState } from "../state/global";
import { Subscription } from "./MySubscribers";
import MySubscriptionRow from "./MySubscriptionRow";
import TransitionLink from "./TransitionLink";

export interface MySubscriptionsPageQuery {
    page: number,
    sort: "-max_price" | "expires",
    reload?: boolean,
}

function getPQfromSP(sp: URLSearchParams): MySubscriptionsPageQuery {
    return {
        page: parseInt(sp.get("page") || "1"),
        sort: sp.get("sort") || "-max_price",
    } as MySubscriptionsPageQuery
}

export default function MySubscriptions() {
    const [loading, setLoading] = useGlobalState('loading')
    // HACKY but I don't like the flash and don't know how to use suspense
    const [loaded, setLoaded] = useState(false)
    const [subscriptions, setSubscriptions] = useState([] as Subscription[])
    const [snack, setSnack] = useGlobalState('snackbar')
    const [searchParams, setSearchParams] = useSearchParams()
    const [pageQuery, setPageQuery] = useState(getPQfromSP(searchParams))
    const [count, setCount] = useState(13)
    const [checked, setChecked] = useState(false)

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
        axios.get(`/api/tuzis/my-subscriptions?page=${pageQuery.page}&ordering=${pageQuery.sort}`)
            .then(response => {
                setSubscriptions(response.data.results)
                setCount(response.data.count)
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
            {(!loading && subscriptions.length === 0) &&
                <Typography>
                    You have not subscribed to anyone.
                    Get out there
                    and <Link to="/find" component={TransitionLink}>find</Link> someone!
                </Typography>
            }
            <List>
                {((!loading || loaded) && subscriptions.length > 0) &&
                    <>
                        <Box
                            component="div"
                            sx={{
                                display: 'flex',
                                justifyContent: 'center',
                                alignItems: 'center'
                            }}
                        >
                            <Typography variant="subtitle1"
                                style={{ marginLeft: "0.5em" }}
                            >
                                Who you subscribe to
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
                {count > 10 &&
                    <Stack
                        direction="row"
                        alignItems="center"
                        justifyContent="center"
                        style={{ marginTop: "0.5em" }}
                    >
                        <Pagination
                            size="small"
                            // TODO: hardcoding breakds
                            count={Math.ceil(count / 10)}
                            page={pageQuery.page}
                            onChange={handleChangePage}
                            variant="outlined"
                            color="primary"
                        />
                    </Stack>
                }


                {subscriptions.map((sub, index) => {
                    return <MySubscriptionRow
                        key={index}
                        sub={sub}
                        index={index}
                        pageQuery={pageQuery}
                        setPageQuery={setPageQuery}
                    />
                })}
            </List>
        </Paper>
    )
}