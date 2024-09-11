import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useNavigate, useLocation } from 'react-router-dom';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import {
    Grid,
    debounce,
} from '@mui/material';
import axios from 'axios';
import { Tag } from './components/TagFilterMultiSelect';
import { QueryFunctionContext, useInfiniteQuery } from 'react-query';

import { AIConversation } from './components/AIConversationListDrawer';
import AIConversationCard from './components/AIConversationCard'; // Assuming you'll have a ConversationCard component
import AIListFilters from './components/AIListFilters'; // Create a new filter component for AI Conversations
import FABNewAI from './components/FABNewAI';
import { Helmet } from 'react-helmet-async';


type ConversationPageData = {
    count: number;
    next: string | null;
    previous: string | null;
    results: AIConversation[];
};

type AIQueryParams = {
    searchTerm: string;
    tags: Tag[];
    sortMode: 'new' | 'hot';
    subscriptionMode: 'all' | 'subscribed';
};

type AIQueryKey = ['public-conversations', AIQueryParams];
type FetchAIArgs = QueryFunctionContext<AIQueryKey, number>;

const fetchPublicConversations = async ({ pageParam = 1, queryKey }: FetchAIArgs): Promise<ConversationPageData> => {
    const [_key, params] = queryKey;
    const { searchTerm, tags, sortMode, subscriptionMode } = params;

    const tagNames = tags.map(tag => tag.name);
    const ordering = sortMode === 'new' ? '-created_at' : '-hot_field'; // Replace 'hot_field' with whatever determines 'hot' for conversations

    const response = await axios.get<ConversationPageData>('/api/ai/public-conversations/', {
        params: {
            page: pageParam,
            search: searchTerm,
            tags: tagNames.join(','),
            ordering
            // Any other params for public-conversations...
        }
    });

    return response.data;
};

const usePublicConversations = (
    searchTerm: string,
    tags: Tag[],
    // TODO: actually implement sort and mode?
    // they don't hurt anything right now, but they're not used
    sortMode: 'new' | 'hot',
    subscriptionMode: 'all' | 'subscribed'
) => {
    return useInfiniteQuery<ConversationPageData, Error, ConversationPageData, AIQueryKey>(
        ['public-conversations', { searchTerm, tags, sortMode, subscriptionMode }],
        fetchPublicConversations,
        {
            getNextPageParam: (lastPage) => {
                if (!lastPage.next) {
                    return null;
                }
                try {
                    const url = new URL(lastPage.next);
                    return url.searchParams.get("page");
                } catch (e) {
                    console.error("Invalid URL in lastPage.next:", lastPage.next);
                    return null;
                }
            }
        }
    );
};

export default function AIList() {
    const searchParams = new URLSearchParams(window.location.search);
    const tagNames = searchParams.get('tags');
    const initialStateTags = tagNames?.length ? tagNames.split(',').map(name => ({ name })) : [];
    const initialState = {
        searchTerm: searchParams.get('searchTerm') || '',
        tags: initialStateTags,
        sortMode: searchParams.get('sortMode') as 'new' | 'hot' || 'new',
        subscriptionMode: searchParams.get('subscriptionMode') as 'all' | 'subscribed' || 'all',
    };

    const [searchTerm, setSearchTerm] = useState(initialState.searchTerm);
    const [sortMode, setSortMode] = useState<'new' | 'hot'>(initialState.sortMode);
    const [subscriptionMode, setSubscriptionMode] = useState<'all' | 'subscribed'>(initialState.subscriptionMode);
    const [tags, setTags] = useState<Tag[]>(initialState.tags);
    const [debouncedSearchTerm, setDebouncedSearchTerm] = useState(searchTerm);

    const navigate = useNavigate();
    const location = useLocation();
    const [showFilters, setShowFilters] = useState(true);
    const [fetchInProgress, setFetchInProgress] = useState(false);
    const virtuosoRef = useRef<VirtuosoHandle | null>(null);
    const lastScrollY = useRef(window.scrollY);
    const [scrollCountHide, setScrollCountHide] = useState(0);
    const [scrollCountShow, setScrollCountShow] = useState(0);

    const [queryChanged, setQueryChanged] = useState(false);

    const {
        data,
        fetchNextPage,
        hasNextPage,
        isLoading,
        isError,
        isSuccess,
    } = usePublicConversations(debouncedSearchTerm, tags, sortMode, subscriptionMode);


    // things that were too complicated in the ConverseList filters
    // that we should revisit later when we have enough public conversations
    // that it even matters
    // const isDataEmpty = data?.pages.every(page => page.results.length === 0);
    // const setFilterHeightCallback = useCallback((height: number) => {
    //     setFilterHeight(height);
    // }, []);

    function scrollToTop() {
        // Scroll to top of Virtuoso
        if (virtuosoRef.current) {
            virtuosoRef.current.scrollToIndex(0);
            virtuosoRef.current.scrollTo({
                top: 0,
                // behavior: 'smooth',
            });
        }
        // Scroll to top of window
        window.scrollTo({
            top: 0,
            // behavior: 'smooth',
        });
    }

    const HIDE_THRESHOLD = 27;
    const SHOW_THRESHOLD = 50;

    const handleScroll = useCallback(() => {
        if (window.scrollY >= lastScrollY.current) {
            // console.log("Incrementing Scroll Count");
            setScrollCountHide(prev => prev + 1);

            if (scrollCountHide >= HIDE_THRESHOLD) {
                // console.log("HIDE FILTERS");
                if (window.scrollY >= 50) {
                    setShowFilters(false);
                    setScrollCountHide(0); // reset the counter after hiding
                }
            }
            setScrollCountShow(0)
        } else {
            setScrollCountShow(prev => prev + 1);
            if (scrollCountShow >= SHOW_THRESHOLD || window.scrollY == 0) {
                setShowFilters(true);
                setScrollCountShow(0);
            }
            setScrollCountHide(0);
        }
        lastScrollY.current = window.scrollY;
    }, [scrollCountShow, scrollCountHide]);

    const dfetchNextPage = useCallback(debounce(fetchNextPage, 100), [fetchNextPage]);

    useEffect(() => {
        // console.log("SEARCHTERM", debouncedSearchTerm, tags, sortMode, subscriptionMode)
        const newSearchParams = new URLSearchParams({
            searchTerm: debouncedSearchTerm,
            tags: tags.map(tag => tag.name).join(','),
            sortMode,
            subscriptionMode
        });
        // navigate(`${location.pathname}?${newSearchParams.toString()}`, { replace: true });
        navigate(`${location.pathname}?${newSearchParams.toString()}`)
        setQueryChanged(true);
    }, [debouncedSearchTerm, tags, sortMode, subscriptionMode]);


    // Scroll effects
    useEffect(() => {
        window.addEventListener('scroll', handleScroll);
        return () => {
            window.removeEventListener('scroll', handleScroll);
        };
    }, [handleScroll]);

    const handleEndReached = useCallback(() => {
        if (hasNextPage && !isLoading && !fetchInProgress) {
            // console.log("FETCHING NEXT PAGE")
            setFetchInProgress(true);
            dfetchNextPage();
        }
    }, [hasNextPage, isLoading, dfetchNextPage, fetchInProgress]);

    useEffect(() => {
        // Reset fetchInProgress when data or isLoading changes
        setFetchInProgress(false);
    }, [data, isLoading]);

    useEffect(() => {
        function scrollToTop() {
            if (window.scrollY === 0) return;
            // Scroll to top of Virtuoso
            if (virtuosoRef.current) {
                virtuosoRef.current.scrollToIndex(0);
                virtuosoRef.current.scrollTo({
                    top: 0,
                    // behavior: 'smooth',
                });
            }
            // Scroll to top of window
            window.scrollTo({
                top: 0,
                // behavior: 'smooth',
            });
        }
        scrollToTop();
    }, [debouncedSearchTerm, tags, sortMode, subscriptionMode]);

    // const topMargin = `${filterHeight + 7}px`;

    const flattenedData = useMemo(() => {
        return data?.pages.flatMap(page => page.results) || [];
    }, [data]);

    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedSearchTerm(searchTerm);
        }, 500); // 500ms delay

        return () => {
            clearTimeout(handler);
        };
    }, [searchTerm]);

    useEffect(() => {
        if (queryChanged) {
            setTimeout(scrollToTop, 300);
            setQueryChanged(false);
        }
    }, [queryChanged]);


    return (
        <>
            <Helmet>
                <title>Chat2Z Public</title>
                <link
                    rel="alternate"
                    type="application/rss+xml"
                    title="Global Public Chat2Z Feed"
                    href="/feeds/ai/recent.xml"
                />
            </Helmet>
            <AIListFilters
            // ... (Similar props to your ConverseListFilters)
            />

            {/* Conversation List */}
            <Grid container spacing={1}
                style={{
                    paddingBottom: "1rem",
                    marginBottom: "1rem",
                }}
            >
                <Grid item xs={12} textAlign="left">
                    {isLoading && !data && <p>Loading...</p>}
                    {isError && <p>Error occurred!</p>}
                    {isSuccess && flattenedData.length === 0 && <p>No results found.</p>}
                    {data && (
                        <Virtuoso
                            ref={virtuosoRef}
                            data={flattenedData}
                            itemContent={(index, item) => <AIConversationCard conversation={item} key={item.id} />}
                            endReached={handleEndReached}
                            useWindowScroll
                            overscan={100}
                            increaseViewportBy={{
                                top: 1000,
                                bottom: 1000,
                            }}
                        />
                    )}
                </Grid>
            </Grid>
            <FABNewAI />
        </>
    );
}
