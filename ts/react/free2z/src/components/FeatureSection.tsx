import { Box, Typography, useTheme, useMediaQuery } from "@mui/material";
import { useState, useEffect } from "react";
import { CSSTransition, TransitionGroup } from 'react-transition-group';
import './FeatureSection.css'; // Import your custom CSS for transitions

interface FeatureSectionProps {
    headlines: string[];
    texts: string[];
    imageUrls?: string[];
    interval?: number; // Interval time for the transition in milliseconds
    imageOnLeft?: boolean; // Whether the image should be on the left side
}

export default function FeatureSection({
    headlines, texts, imageUrls = [],
    interval = 10000,
    imageOnLeft = false,
}: FeatureSectionProps) {
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down("md"));
    const [visible, setVisible] = useState(false);
    const [index, setIndex] = useState(0);

    const sectionId = `feature-section`; // Unique ID for the section

    useEffect(() => {
        const section = document.getElementById(sectionId);
        const checkVisibility = () => {
            if (!section) return;
            const position = section.getBoundingClientRect();
            if (position.top < window.innerHeight && position.bottom >= 0) {
                setVisible(true);
                window.removeEventListener('scroll', checkVisibility);
            }
        };
        checkVisibility(); // Check visibility on mount in case the section is already in view
        window.addEventListener('scroll', checkVisibility);
        return () => window.removeEventListener('scroll', checkVisibility);
    }, [sectionId]);

    useEffect(() => {
        const timer = setInterval(() => {
            setIndex((prevIndex) => (prevIndex + 1) % headlines.length);
        }, interval);
        return () => clearInterval(timer);
    }, [headlines.length, interval]);

    return (
        <Box
            component={'section'}
            id={sectionId}
            sx={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                backgroundColor: theme.palette.background.paper,
                borderRadius: theme.spacing(1),
                boxShadow: theme.shadows[1],
                width: '100%',
                overflow: 'hidden', // Hide overflowing content
                minHeight: {
                    "xs": "520px",
                    "sm": "640px",
                    "md": "350px",
                    "lg": "420px",
                    "xl": "500px",
                },
                margin: {
                    xs: theme.spacing(1, 1),
                    sm: theme.spacing(2, 1),
                    md: theme.spacing(3, 1),
                },
                padding: {
                    xs: theme.spacing(1),
                    sm: theme.spacing(2),
                    md: theme.spacing(3),
                },
            }}
        >
            <TransitionGroup>
                <CSSTransition
                    key={index}
                    timeout={1000}
                    classNames="fade"
                >
                    <Box
                        component={'div'}
                        sx={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: '100%',
                            display: 'flex',
                            flexDirection: isMobile ? 'column' : 'row',
                            alignItems: 'center',
                            justifyContent: isMobile ? 'flex-start' : 'space-around',
                        }}
                    >
                        <Box
                            component="div"
                            sx={{
                                flex: 1,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: isMobile ? '95%' : '50%',
                                // height: isMobile ? '100%' : 'auto',
                                order: imageOnLeft ? 1 : 2,
                                margin: {
                                    xs: "0 1em 0 1em",
                                    md: "1em",
                                },
                            }}
                        >
                            <Box
                                component="img"
                                src={imageUrls[index]}
                                sx={{
                                    width: '100%',
                                    height: 'auto',
                                    objectFit: 'contain',
                                    borderRadius: theme.shape.borderRadius,
                                    margin: {
                                        xs: "0 1em 1em 1em",
                                        sm: "0 1em 1em 1em",
                                        md: "1em",
                                    },
                                }}
                                alt={headlines[index]}
                            />
                        </Box>
                        <Box
                            component={'div'}
                            sx={{
                                flex: 1,
                                padding: {
                                    xs: theme.spacing(0, 1),
                                    sm: theme.spacing(1, 2),
                                    md: theme.spacing(1, 3),
                                    lg: theme.spacing(1, 4),
                                },
                                order: imageOnLeft ? 2 : 1,
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: isMobile ? 'center' : 'flex-start',
                                textAlign: isMobile ? 'center' : 'left',
                                justifyContent: 'center',
                            }}
                        >
                            <Typography
                                variant="h4" component="h2"
                                sx={{
                                    marginTop: isMobile ? theme.spacing(1) : 0,
                                    marginBottom: isMobile ? theme.spacing(1) : 0,
                                }}
                            >
                                {headlines[index]}
                            </Typography>
                            <Typography
                                variant="body1"
                                sx={{
                                    fontSize: '1.1rem',
                                }}
                                dangerouslySetInnerHTML={{ __html: texts[index] }}
                            />

                        </Box>
                    </Box>
                </CSSTransition>
            </TransitionGroup>
        </Box>
    );
}
