import { useEffect } from "react";
import { IconButton } from "@mui/material";
import { useSnackbar } from 'notistack';
import { ArrowRight, Close } from "@mui/icons-material";
import { useQueryClient } from "react-query";

import { useWebSocket } from "../hooks/useWebSocket";
import { useTransitionNavigate } from "../hooks/useTransitionNavigate";
import { EventAPIResponse } from "./EventFeed";
import { useMarkAsRead } from "../hooks/useMarkAsRead";


export default function CreatorSnackSocket() {
    const { lastEvent } = useWebSocket();
    const navigate = useTransitionNavigate();
    const { enqueueSnackbar, closeSnackbar } = useSnackbar();
    const queryClient = useQueryClient();
    const markRead = useMarkAsRead()

    useEffect(() => {

        if (lastEvent) {
            if (!lastEvent.read) {
                queryClient.invalidateQueries('unreadNotifications')
                enqueueSnackbar(lastEvent.message, {
                    key: lastEvent.id,
                    persist: true,
                    variant: 'info',  // Set the variant to 'info'
                    action: key => (
                        <>
                            <IconButton
                                onClick={() => {
                                    closeSnackbar(key);
                                    markRead.mutate(lastEvent.id);
                                }}
                                size="small"
                            >
                                <Close fontSize="small" />
                            </IconButton>
                            <IconButton
                                onClick={() => {
                                    closeSnackbar(key)
                                    markRead.mutate(lastEvent.id);
                                    navigate(lastEvent.content_url);
                                }}
                                size="small"
                            >
                                <ArrowRight fontSize="small" />
                            </IconButton>
                        </>
                    ),
                });
            }
            queryClient.setQueryData<{ pages: EventAPIResponse[] }>('events', oldData => {
                if (!oldData) {
                    oldData = {
                        pages: [{
                            count: 1,
                            next: null,
                            previous: null,
                            results: [lastEvent],
                        }]
                    };
                }

                return {
                    pages: [
                        {
                            count: oldData.pages[0].count + 1,  // Update the count of events
                            next: oldData.pages[0].next,  // keep the old next value
                            previous: oldData.pages[0].previous,  // keep the old previous value
                            results: [lastEvent, ...oldData.pages[0].results],  // prepend the new event
                        },
                        ...oldData.pages.slice(1),  // Keep the rest of the pages as they are
                    ],
                };
            });
        }
    }, [lastEvent]);

    return null; // You don't need to return anything from this component anymore
}
