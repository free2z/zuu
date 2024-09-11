import { Swiper, SwiperSlide } from 'swiper/react';
import { Swiper as SwiperClass } from 'swiper';
import SwiperCore, { Autoplay, Navigation } from 'swiper';
import { Avatar, Card, CardContent, CardMedia, Typography } from '@mui/material';

// Import Swiper styles
import 'swiper/css';
import 'swiper/css/navigation';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageInterface } from './PageRenderer';
import SwiperLoadingAnimation from './SwiperLoadingAnimation';
import { useTransitionNavigate } from '../hooks/useTransitionNavigate';
import { HOME_CAROUSEL_BREAKPOINTS } from './HomeCarouselConstants';
import HoverCard from './common/HoverCard';

SwiperCore.use([Autoplay, Navigation]);

type ZPageCarouselProps = {
    sort: "score" | "updated" | "random"
}

export default function ZPageCarousel(props: ZPageCarouselProps) {
    const { sort } = props
    const [zpages, setzPages] = useState<PageInterface[]>([]);
    const [fetching, setFetching] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [page, setPage] = useState(1);
    const lastElement = useRef<HTMLDivElement | null>(null);
    const swiperRef = useRef<SwiperClass | null>(null);
    const navigate = useTransitionNavigate()

    const fetchData = useCallback(async (triggeredByObserver = false) => {
        if (fetching || !hasMore || (!triggeredByObserver && page !== 1)) return;
        // console.log("FETCH", page)
        setFetching(true);

        try {
            // TODO: filter - must have images, >100 2Zs ...
            const response = await axios.get('/api/zpage/', {
                params: {
                    page,
                    homeSort: sort,
                },
            });

            if (response.status === 200) {
                setzPages((prevPages) => {
                    const newResults = response.data.results as PageInterface[];
                    const updatedPages = [...prevPages];

                    newResults.forEach((newPage) => {
                        if (!updatedPages.some((prevPage) => prevPage.vanity === newPage.vanity)) {
                            updatedPages.push(newPage);
                        }
                    });

                    return updatedPages;
                });
                setPage((prevPage) => prevPage + 1);
            }
        } catch (error) {
            console.error('Error fetching creators:', error);
            setHasMore(false);
        } finally {
            setFetching(false);
        }
    }, [fetching, page, sort]);

    useEffect(() => {
        fetchData();
    }, [fetchData])

    useEffect(() => {
        setPage(1);
        setzPages([]);
        if (swiperRef.current) {
            swiperRef.current.slideTo(0);
        }
    }, [sort]);

    return (
        <Swiper
            slidesPerView="auto"
            // centeredSlides={true}
            navigation
            breakpoints={HOME_CAROUSEL_BREAKPOINTS}
            onSwiper={(swiper) => {
                swiperRef.current = swiper;
            }}
            onSlideChange={() => {
                const slideIndex = swiperRef.current?.activeIndex;
                if (slideIndex && zpages.length - slideIndex <= 5 && !fetching && hasMore) {
                    fetchData(true);
                }
            }}
        >
            {zpages.length === 0 ?
                <SwiperSlide
                    style={{
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                        minHeight: 320,
                        minWidth: 320,
                        position: 'relative',
                        // marginLeft: 'auto',
                        // marginRight: 'auto',
                    }}
                >
                    <SwiperLoadingAnimation />
                </SwiperSlide>
                :
                zpages.map((zpage, index) => (
                    <SwiperSlide
                        key={zpage.free2zaddr}

                    >
                        <div
                            ref={index === zpages.length - 1 ? lastElement : null}
                        >

                            <HoverCard
                                onClick={() => {
                                    navigate(zpage.get_url);
                                }}
                            >

                                <CardMedia
                                    style={{
                                        minHeight: 180,
                                    }}
                                    image={zpage.featured_image?.thumbnail}
                                    title={zpage.title}
                                />
                                <CardContent
                                    style={{
                                        paddingTop: '7%',
                                        paddingBottom: '5%',
                                        paddingRight: 8,
                                    }}
                                >
                                    <div
                                        style={{
                                            display: 'grid',
                                            gridTemplateColumns: 'auto 1fr',
                                            gridGap: '8px',
                                            alignItems: 'center',
                                        }}
                                    >
                                        <Avatar
                                            src={zpage.creator.avatar_image?.thumbnail}
                                            alt={zpage.creator.username}
                                            style={{
                                                width: 40,
                                                height: 40,
                                                marginRight: 10,
                                                marginLeft: 5,
                                            }}
                                        />
                                        <Typography
                                            variant="h6"
                                            noWrap
                                            style={{
                                                fontSize: '1rem',
                                                fontWeight: 800,
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'pre-wrap',
                                                maxHeight: '2.5em',
                                                lineHeight: '1.25em',
                                                display: '-webkit-box',
                                                WebkitBoxOrient: 'vertical',
                                                WebkitLineClamp: 2,
                                                textAlign: 'left',
                                            }}
                                        >
                                            {zpage.title}
                                        </Typography>
                                    </div>
                                    <Typography
                                        variant="body2"
                                        style={{
                                            display: '-webkit-box',
                                            WebkitBoxOrient: 'vertical',
                                            WebkitLineClamp: 2,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            textAlign: "left",
                                            padding: "0.3em 0 0 0",
                                            margin: "0.3em 0 0 0",
                                            fontWeight: 300,
                                        }}
                                    >
                                        {zpage.is_subscriber_only &&
                                            <Typography
                                                component="span"
                                                sx={{
                                                    fontSize: '0.9rem',
                                                    color: (theme) => theme.palette.secondary.main,
                                                }}
                                            >Subscribers only<br /></Typography>
                                        }
                                        {zpage.content}
                                    </Typography>
                                </CardContent>
                            </HoverCard>
                        </div>
                    </SwiperSlide>

                ))}
        </Swiper>
    );
}
