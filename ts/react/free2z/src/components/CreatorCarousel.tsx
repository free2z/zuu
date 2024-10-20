import { Swiper, SwiperSlide } from 'swiper/react';
import { Swiper as SwiperClass } from 'swiper';
import SwiperCore, { Autoplay, Navigation } from 'swiper';
import {  CardActionArea, CardContent, CardMedia, Typography } from '@mui/material';

// Import Swiper styles
import 'swiper/css';
import 'swiper/css/navigation';
import { PublicCreator } from '../CreatorDetail';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import SwiperLoadingAnimation from './SwiperLoadingAnimation';
import { HOME_CAROUSEL_BREAKPOINTS } from './HomeCarouselConstants';
import HoverCard from './common/HoverCard';

SwiperCore.use([Autoplay, Navigation]);

const truncate = (text: string, maxLength = 40): string => {
    if (!text) return text;
    if (text.length > maxLength) {
        return text.slice(0, maxLength) + '...';
    }
    return text;
};

type CreatorCarouselProps = {
    sort: "score" | "updated" | "random"
}

export default function CreatorCarousel(props: CreatorCarouselProps) {
    const { sort } = props

    const [creators, setCreators] = useState<PublicCreator[]>([]);
    const [fetching, setFetching] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [page, setPage] = useState(1);
    const lastElement = useRef<HTMLDivElement | null>(null);
    const [sortChanged, setSortChanged] = useState(false)
    const swiperRef = useRef<SwiperClass | null>(null);

    const fetchData = useCallback(async (triggeredByObserver = false) => {
        // console.log("FETCHDATA", fetching, hasMore, triggeredByObserver, page)
        if (fetching || !hasMore || (!triggeredByObserver && page !== 1)) return;
        // console.log("FETCH", page)
        setFetching(true);

        try {
            // TODO: filter - must have images, >100 2Zs ...
            const response = await axios.get('/api/creator/', {
                params: {
                    page,
                    homeSort: sort,
                },
            });

            if (response.status === 200) {
                setCreators((prevCreators) => {
                    const newResults = response.data.results as PublicCreator[];
                    const updatedCreators = [...prevCreators];

                    newResults.forEach((newCreator) => {
                        if (!updatedCreators.some((prevCreator) => prevCreator.username === newCreator.username)) {
                            updatedCreators.push(newCreator);
                        }
                    });

                    return updatedCreators;
                });
                setPage((prevPage) => prevPage + 1);
                if (sortChanged) setSortChanged(false)
            }
        } catch (error) {
            console.error('Error fetching creators:', error);
            setHasMore(false);
        } finally {
            setFetching(false);
        }
    }, [fetching, page, sort]);

    useEffect(() => {
        // console.log("CHANGE SORT")
        setPage(1)
        setCreators([])
        setSortChanged(true)
        if (swiperRef.current) {
            swiperRef.current.slideTo(0);
        }
    }, [sort])

    useEffect(() => {
        fetchData(false);
    }, [fetchData]);

    return (
        <Swiper
            slidesPerView="auto"
            navigation
            breakpoints={HOME_CAROUSEL_BREAKPOINTS}
            onSwiper={(swiper) => {
                swiperRef.current = swiper;
            }}
            onSlideChange={() => {
                const slideIndex = swiperRef.current?.activeIndex;
                if (slideIndex && creators.length - slideIndex <= 5 && !fetching && hasMore) {
                    fetchData(true);
                }
            }}
        >
            {creators.length === 0 ?
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
                : creators.map((creator, index) => (
                    <SwiperSlide
                        key={creator.username}

                    >
                        <div
                            ref={index === creators.length - 1 ? lastElement : null}
                        >
                            <HoverCard>
                            {/* Add CardActionArea to allow the Card to function as an `<a>` tag */}
                            <CardActionArea href={creator.username}>
                                {/* Replace `CardMedia` with an `img` HTML tag. `CardMedia` does not have all the accessibility features that `img` provides */}
                                <img
                                    src={creator.banner_image?.thumbnail}
                                    alt={creator.full_name || creator.username}
                                    style={{
                                    minHeight: 180,
                                    maxHeight: 180,
                                    objectFit: "cover",
                                    width: "100%",
                                    }}
                                />
                                <div
                                    style={{
                                        width: '25%',
                                        height: 0,
                                        paddingBottom: '25%',
                                        // maxWidth: 90,
                                        // maxHeight: 90,
                                        borderRadius: '50%',
                                        position: 'absolute',
                                        top: '50%',
                                        left: 'calc(50% - (25%/2))',
                                        overflow: 'hidden',
                                    }}
                                >
                                    <CardMedia
                                        component="img"
                                        src={creator.avatar_image?.thumbnail}
                                        alt={creator.full_name || creator.username}
                                        style={{
                                            width: '100%',
                                            height: '100%',
                                            objectFit: 'cover',
                                            position: 'absolute',
                                            top: 0,
                                            left: 0,
                                        }}
                                    />
                                </div>

                                <CardContent
                                    style={{
                                        paddingTop: 'calc(10% + (25%/2))',
                                    }}
                                >
                                    <Typography
                                        variant="h6"
                                        noWrap
                                        style={{
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        {truncate(creator.full_name || creator.username, 33)}
                                    </Typography>
                                </CardContent>
                                </CardActionArea >
                            </HoverCard>
                        </div>
                    </SwiperSlide>
                ))}
        </Swiper>
    );
}
