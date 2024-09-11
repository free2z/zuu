import React from 'react';
import SwiperCore, { Autoplay, Navigation } from 'swiper';
import { Swiper, SwiperSlide } from 'swiper/react';
import { Card, CardContent, CardMedia, Typography, Avatar } from '@mui/material';
import 'swiper/css';
import 'swiper/css/navigation';
import axios from 'axios';
import { useQuery } from 'react-query';
import { useTransitionNavigate } from '../hooks/useTransitionNavigate';
import { PageInterface } from './PageRenderer';
import { ellipsis } from 'polished';

export interface PageOrderInterface {
    id: string;
    page: PageInterface;
    order: number;
}

export interface SeriesInterface {
    id: string;
    name: string;
    pageorder_set: PageOrderInterface[];
    created_at: string;
    updated_at: string;
}

export const useSeries = (free2zaddr: string) => {
    return useQuery<SeriesInterface>(['series', free2zaddr], async () => {
        const { data } = await axios.get(`/api/g12f/zpage/${free2zaddr}/series/`);
        return data;
    });
}

SwiperCore.use([Autoplay, Navigation]);

interface SeriesComponentProps {
    free2zaddr: string;
    // currentPage?: string;
}

const SeriesCarousel: React.FC<SeriesComponentProps> = ({ free2zaddr }) => {
    const { data, isLoading, error } = useSeries(free2zaddr);
    const navigate = useTransitionNavigate();

    // TODO: could handle loading and error states better
    // if (isLoading) return <div>Loading...</div>;
    if (!data) return <></>;

    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', margin: '1.5em 0 0.75em 0' }}>
                <Avatar
                    src={data?.pageorder_set[0]?.page.creator.avatar_image?.thumbnail}
                    alt={data?.pageorder_set[0]?.page.creator.username}
                    style={{ marginRight: '0.5em', cursor: 'pointer' }}
                    onClick={() => {
                        const username = data?.pageorder_set[0]?.page.creator.username
                        if (username) {
                            navigate(`/${username}`)
                        }
                    }}
                />
                <Typography variant="h5">{data?.name}</Typography>
            </div>
            <Swiper
                centeredSlides
                // initialSlide={data?.pageorder_set?.findIndex(po => po.page.free2zaddr === free2zaddr) + 1 || 0}
                initialSlide={(data?.pageorder_set || []).findIndex(po => po.page.free2zaddr === free2zaddr) + 1 || 0}
                spaceBetween={10}
                slidesPerView={'auto'}
                navigation
                breakpoints={{
                    0: { slidesPerView: 1, spaceBetween: 10 },
                    384: { slidesPerView: 2, spaceBetween: 10 },
                    768: { slidesPerView: 3, spaceBetween: 10 },
                    // 1024: { slidesPerView: 4, spaceBetween: 10 },
                }}
            >
                {data?.pageorder_set.map((pageOrder) => (
                    <SwiperSlide key={pageOrder.page.free2zaddr}>
                        <Card
                            onClick={() => {
                                if (pageOrder.page.free2zaddr !== free2zaddr) {
                                    navigate(pageOrder.page.get_url)
                                    setTimeout(() => window.scrollTo(0, 0), 500)
                                }
                            }}
                            style={pageOrder.page.free2zaddr === free2zaddr ? { cursor: 'default', opacity: 0.5 } : { cursor: 'pointer' }}
                        >
                            <CardMedia
                                style={{ height: 170 }}
                                image={pageOrder.page.featured_image?.thumbnail || '/docs/img/tuzi.svg'}
                                title={pageOrder.page.title}
                            />
                            <CardContent style={{ height: 85 }}>
                                <Typography
                                    variant="h6"
                                    component="div"
                                    style={{
                                        ...ellipsis('100%'), // truncate to single line
                                        fontWeight: 700,
                                        fontSize: '1rem', // adjust font size as needed
                                        marginBottom: '0.3em',
                                        height: '1.2em', // set height for a single line of text
                                        lineHeight: '1.2em'
                                    }}
                                >
                                    {pageOrder.page.title}
                                </Typography>
                                <Typography
                                    variant="body2"
                                    // style={{
                                    //     ...ellipsis('100%'), // truncate to double line
                                    //     height: '2.4em', // set height for two lines of text
                                    //     lineHeight: '1.2em'
                                    // }}
                                    style={{
                                        display: '-webkit-box',
                                        WebkitLineClamp: 3,
                                        WebkitBoxOrient: 'vertical',
                                        overflow: 'hidden',
                                        lineHeight: '1.2em'
                                    }}
                                >
                                    {pageOrder.page.content}
                                </Typography>
                            </CardContent>
                        </Card>
                    </SwiperSlide>
                ))}
            </Swiper>
        </div>
    );
}

export default SeriesCarousel;
