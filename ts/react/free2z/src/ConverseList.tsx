import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Grid,
    debounce,
} from '@mui/material';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';

import CommentCard from './components/CommentCardInfinite';
import { ConverseListFilters } from './components/ConverseListFilters';
import { useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';
import { Tag } from './components/TagFilterMultiSelect';
import { QueryFunctionContext, useInfiniteQuery } from 'react-query';
import { CommentData } from './components/DisplayThreadedComments';
import { Helmet } from 'react-helmet-async';


type CommentPageData = {
    count: number;
    next: string | null;
    previous: string | null;
    results: CommentData[];
};

type CommentsQueryParams = {
    searchTerm: string;
    tags: Tag[];
    sortMode: 'new' | 'hot';
    subscriptionMode: 'all' | 'subscribed';
};

type CommentsQueryKey = ['comments', CommentsQueryParams];
type FetchCommentsArgs = QueryFunctionContext<CommentsQueryKey, number>;


const fetchComments = async ({ pageParam = 1, queryKey }: FetchCommentsArgs): Promise<CommentPageData> => {
    const [_key, params] = queryKey;
    const { searchTerm, tags, sortMode, subscriptionMode } = params;

    const tagNames = tags.map(tag => tag.name);
    const ordering = sortMode === 'new' ? '-created_at' : '-tuzis';
    const subscribed_to = subscriptionMode === 'subscribed' ? 1 : 0;

    const response = await axios.get<CommentPageData>('/api/comments/', {
        params: {
            page: pageParam,
            search: searchTerm,
            tags: tagNames.join(','),
            ordering,
            subscribed_to
        }
    });

    return response.data;
};

const useComments = (
    searchTerm: string,
    tags: Tag[],
    sortMode: 'new' | 'hot',
    subscriptionMode: 'all' | 'subscribed'
) => {
    return useInfiniteQuery<CommentPageData, Error, CommentPageData, CommentsQueryKey>(
        ['comments', { searchTerm, tags, sortMode, subscriptionMode }],
        fetchComments,
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
            },
            // staleTime: 60 * 60 * 1000,
            // cacheTime: 60 * 60 * 1000,
            // refetchOnWindowFocus: false,
            // refetchOnReconnect: false,
        }
    );
};


export default function ConverseList() {
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
    } = useComments(debouncedSearchTerm, tags, sortMode, subscriptionMode);

    const [filterHeight, setFilterHeight] = useState(0);

    const setFilterHeightCallback = useCallback((height: number) => {
        setFilterHeight(height);
    }, []);

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
    const isDataEmpty = data?.pages.every(page => page.results.length === 0);

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

    const topMargin = `${filterHeight + 7}px`;

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
                <title>Free2Z Converse</title>
                <link
                    rel="alternate"
                    type="application/rss+xml"
                    title="Global Free2Z Converse Feed"
                    href="/feeds/converse/recent.xml"
                />
            </Helmet>
            <ConverseListFilters
                setFilterHeight={setFilterHeightCallback}
                showFilters={showFilters}
                // setShowFilters={setShowFilters}
                searchTerm={searchTerm}
                setSearchTerm={setSearchTerm}
                tags={tags}
                setTags={setTags}
                sortMode={sortMode}
                setSortMode={setSortMode}
                subscriptionMode={subscriptionMode}
                setSubscriptionMode={setSubscriptionMode}
            />

            {/* Comment List */}
            <Grid container spacing={1}
                style={{
                    paddingBottom: "1rem"
                }}
            >
                <Grid item xs={12} textAlign="left" style={{ marginTop: topMargin }}>
                    {isLoading && !data && <p>Loading...</p>}
                    {isError && <p>Error occurred!</p>}
                    {isSuccess && isDataEmpty && <p>No results found.</p>}
                    {data && (
                        <Virtuoso
                            ref={virtuosoRef}
                            data={flattenedData}
                            itemContent={(index, item) => <CommentCard comment={item} key={item.uuid} />}
                            endReached={handleEndReached}
                            useWindowScroll
                            overscan={200}
                            increaseViewportBy={{
                                top: 50000,
                                bottom: 2000,
                            }}
                        />
                    )}
                </Grid>
            </Grid >
        </>
    );
}
