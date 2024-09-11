import React from 'react';
import axios from 'axios';
import { Drawer, Link, useTheme } from "@mui/material";
import { useInfiniteQuery } from 'react-query';
import { List, ListItem, ListItemText, CircularProgress } from '@mui/material';
import { useInView } from 'react-intersection-observer';
import TransitionLink from './TransitionLink';
import { PublicCreator } from '../CreatorDetail';

const drawerWidth = 277;

export interface AIConversation {
    id: string;
    ai_model: string;
    display_name: string;
    model_name: string;
    user: PublicCreator;
    created_at: string;
    updated_at: string;
    is_public: boolean;
    is_subscriber_only: boolean;
    tags?: string[];
}

interface APIResponse {
    count: number;
    next: string | null;
    previous: string | null;
    results: AIConversation[];
}

interface AIConversationListDrawerProps {
    open: boolean;
    setOpen: React.Dispatch<React.SetStateAction<boolean>>
}

const fetchConversations = async ({ pageParam = '/api/ai/conversations/' }) => {
    axios.defaults.withCredentials = true
    const res = await axios.get<APIResponse>(pageParam);
    return res.data;
}

export default function AIConversationListDrawer(props: AIConversationListDrawerProps) {
    const theme = useTheme();
    const {
        data, fetchNextPage, hasNextPage, isFetchingNextPage, isFetching
    } = useInfiniteQuery('conversations', fetchConversations, {
        getNextPageParam: (lastPage, pages) => lastPage.next || undefined,
    });

    const { ref, inView } = useInView({
        threshold: 0,
    });

    React.useEffect(() => {
        if (inView && hasNextPage) {
            fetchNextPage();
        }
    }, [inView, hasNextPage, fetchNextPage]);

    return (
        <Drawer
            // variant="persistent"
            anchor="left"
            open={props.open}
            sx={{
                width: drawerWidth,
                flexShrink: 0,
                '& .MuiDrawer-paper': {
                    width: drawerWidth,
                    boxSizing: 'border-box',
                    background: theme.palette.mode === 'dark' ?
                        theme.palette.grey[900] : theme.palette.grey[100],
                },
            }}
        >
            <List
                style={{
                    marginTop: '64px',
                }}
            >
                {data?.pages && data?.pages[0].results.length === 0 && !isFetching && (
                    <ListItem>
                        <ListItemText primary="No conversations" />
                    </ListItem>
                )}

                {data?.pages.map((group, i) => (
                    <React.Fragment key={i}>
                        {group.results.map((conversation) => (
                            <ListItem key={conversation.id}>
                                <ListItemText
                                    onClick={() => props.setOpen(false)}
                                    primary={
                                        <Link
                                            color="inherit"
                                            variant="caption"
                                            to={`/ai/${conversation.id}`}
                                            component={TransitionLink}
                                        >
                                            {conversation.display_name}
                                        </Link>
                                    }
                                    secondary={`${conversation.model_name}`}
                                />
                            </ListItem>
                        ))}
                    </React.Fragment>
                ))}
                <div ref={ref}>
                    {isFetchingNextPage ? <CircularProgress /> : null}
                </div>
            </List>
        </Drawer>
    );
}
