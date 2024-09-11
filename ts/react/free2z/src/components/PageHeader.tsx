import { Box, Stack, Typography } from "@mui/material";
import useScroll from "../hooks/useScroll";
import AvatarLink from "./AvatarLink";
import PageDateTimes from "./PageDateTimes";
import { PageInterface } from "./PageRenderer";
import { ReactNode } from "react";

const hexToRgba = (hex: string, opacity: number): string => {
    const hexCode = hex.startsWith("#") ? hex.substring(1) : hex;
    const hexMatch = hexCode.length === 3 ? hexCode.match(/\w/g) : hexCode.match(/\w\w/g);
    if (!hexMatch) return "";
    const [r, g, b] = hexMatch.map((x) => parseInt(x.length === 1 ? x + x : x, 16));
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
};

export default function PageHeader(props: PageInterface & { tocComponent?: ReactNode }) {
    const scrollY = useScroll();
    // GPT says smaller is more subtle
    const parallaxFactor = 0.33;
    const offset = 25;

    return (
        <Box
            component="div"
            sx={{
                position: "relative",
                borderRadius: "0 0 10px 10px",
                width: "100%",
                overflow: "hidden",
            }}
        >
            <Box
                component="div"
                sx={{
                    position: "absolute",
                    top: -offset,
                    left: 0,
                    bottom: -offset,
                    right: 0,
                    ...(props.featured_image && {
                        backgroundImage: `url("${props.featured_image.thumbnail}")`,
                        backgroundSize: "cover",
                        backgroundRepeat: "no-repeat",
                        backgroundPosition: `center calc(50% + ${scrollY * parallaxFactor}px)`,
                    }),
                }}
            ></Box>
            <Box
                component="div"
                sx={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    bottom: 0,
                    right: 0,
                    backgroundColor: (theme) => hexToRgba(theme.palette.background.paper, 0.73),
                }}
            ></Box>
            <Box
                component="div"
                sx={{
                    position: "relative",
                    padding: "1em 1em 0.75em 1em",
                }}
            >
                <Stack
                    direction="column"
                    alignItems="center"
                    justifyContent="center"
                    spacing={1}
                >
                    <Typography margin="0" variant="h3" textAlign="center">
                        {props.title}
                    </Typography>
                    <AvatarLink {...props.creator} />
                    <PageDateTimes {...props} />
                    {props.tocComponent}
                </Stack>
            </Box>
        </Box>
    );
}
