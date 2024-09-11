import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useInfiniteQuery, useMutation, useQueryClient } from 'react-query';
import {
    List, ListItem, ListItemText, CircularProgress, Avatar, Link, Stack,
    Box, useTheme, Button, Switch, Tooltip,
} from '@mui/material';
import { useInView } from 'react-intersection-observer';
import { useGlobalState } from '../state/global';
import TransitionLink from './TransitionLink'
import moment from 'moment';
import { useTransitionNavigate } from '../hooks/useTransitionNavigate';
import { EventData } from '../hooks/useWebSocket';
import { useMarkAsRead } from '../hooks/useMarkAsRead';


export interface EventAPIResponse {
    count: number;
    next: string | null;
    previous: string | null;
    results: EventData[];
}

export default function EventFeed() {
    const [loginModal, setLoginModal] = useGlobalState("loginModal")
    const [snackbar, setSnackbar] = useGlobalState('snackbar')
    const [authStatus, setAuthStatus] = useGlobalState("authStatus")
    const [showAllEvents, setShowAllEvents] = useState(false);
    const theme = useTheme()
    const queryClient = useQueryClient()
    const navigate = useTransitionNavigate()
    const markRead = useMarkAsRead()

    const markAllEventsAsRead = async () => {
        await axios.post('/api/events/read/all/');
    }

    const { ref, inView } = useInView({
        threshold: 0,
    });

    const {
        data, fetchNextPage, hasNextPage, isFetchingNextPage, isFetching
    } = useInfiniteQuery(['events', showAllEvents], ({ pageParam }) => {
        const url = pageParam || (showAllEvents ? '/api/events/' : '/api/events/?type=social');
        axios.defaults.withCredentials = true;
        return axios.get<EventAPIResponse>(url).then((res) => res.data);
    }, {
        enabled: !!authStatus,
        getNextPageParam: (lastPage, pages) => lastPage.next || undefined,
    });

    const handleSwitchChange = () => {
        setShowAllEvents((prev) => !prev);
    }

    const markAllRead = useMutation(markAllEventsAsRead, {
        onMutate: async () => {
            await queryClient.cancelQueries('events');
            const previousData = queryClient.getQueryData<{ pages: EventAPIResponse[] }>('events');

            if (previousData) {
                queryClient.setQueryData<{ pages: EventAPIResponse[] }>('events', {
                    pages: previousData.pages.map(page => ({
                        ...page,
                        results: page.results.map((event: EventData) => ({ ...event, read: true }))
                    }))
                });
            }

            return { previousData }
        },
        onError: (err, variables, context) => {
            if (context?.previousData) {
                queryClient.setQueryData<{ pages: EventAPIResponse[] }>('events', context.previousData);
            }
        },
        onSuccess: () => {
            queryClient.refetchQueries('events');
            queryClient.invalidateQueries('unreadNotifications');
            setSnackbar({
                open: true,
                severity: "success",
                message: "All marked as read",
                duration: 5000,
            });
        },
    });

    useEffect(() => {
        if (inView && hasNextPage) {
            fetchNextPage();
        }
    }, [inView, hasNextPage, fetchNextPage]);

    useEffect(() => {
        setLoginModal(authStatus === false)
    }, [authStatus])

    if (!data) return null

    return (
        <span
            style={{
                marginTop: "1em",
                width: "100%",
            }}
        >
            {/* Make a row stack */}
            <Stack
                direction="row"
                justifyContent="space-between"
                alignItems="center"
                spacing={1}
            >
                <Button
                    onClick={() => {
                        markAllRead.mutate();
                    }}
                >
                    Mark all as read
                </Button>

                <Tooltip title={showAllEvents ? "Show only social events" : "Show all events"}>
                    <Switch
                        checked={showAllEvents}
                        onChange={handleSwitchChange}
                    />
                </Tooltip>
            </Stack>

            <List>
                {data?.pages && data?.pages[0].results.length === 0 && !isFetching && (
                    <ListItem>
                        <ListItemText primary="No events" />
                    </ListItem>
                )}

                {data?.pages.map((group, i) => (
                    <React.Fragment key={i}>
                        {group.results.map((event) => (
                            <Box
                                component="div"
                                key={event.id}
                                bgcolor={event.read ? theme.palette.background.default : theme.palette.action.selected}
                            >
                                <ListItem key={event.id}>
                                    <Stack direction="row" spacing={2}>
                                        {/* TODO: maybe here we want payee if the contributor is the receiving user */}
                                        {event.contributor ?
                                            <Link
                                                component={TransitionLink}
                                                to={`/${event.contributor.username}`}
                                            >
                                                <Avatar src={event.contributor.avatar_image?.thumbnail} />
                                            </Link>
                                            : <Avatar src="https://free2z.com/docs/img/tuzi.svg" />
                                        }
                                        <ListItemText
                                            primary={
                                                event.content_url ?
                                                    <Link
                                                        href={event.content_url}
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            markRead.mutate(event.id);
                                                            navigate(event.content_url)
                                                        }}
                                                    >
                                                        {event.message}
                                                    </Link>
                                                    : event.message
                                            }
                                            // TODO: where contributor == current user, show payee here instead of contributor
                                            secondary={
                                                `${event.contributor ? `From: ${event.contributor.username} | ` : ""}
                                         ${event.amount ? `${event.amount} tuzis | ` : ""}
                                         ${moment.utc(event.created_at).fromNow()}`
                                            }
                                        />
                                    </Stack>
                                </ListItem>
                            </Box>
                        ))}
                    </React.Fragment>
                ))}
                <div
                    ref={ref}
                ></div>
                {isFetchingNextPage && (
                    <Box component="div" display="flex" justifyContent="center" alignItems="center" p={2}>
                        <CircularProgress />
                    </Box>
                )}
            </List>
        </span>
    );
}
