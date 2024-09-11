import { MoreVert } from "@mui/icons-material"
import { Card, CardMedia, CardContent, Typography, Avatar, CardHeader, Divider, IconButton, Link, ListItem, Popover, Stack, useMediaQuery, Grid } from "@mui/material"
import moment from "moment"
import CreatorDonate from "./CreatorDonate"
import { Story } from "./StoryTimeEdit"
import UpDownPage from "./UpDownPage"

import { useEffect, useRef, useState } from "react"
import TransitionLink from "./TransitionLink"

function getFirstNonEmptyPageContent(story: Story) {
    const firstNonEmptyPage = story.pages.find(page => !!page.content);
    if (firstNonEmptyPage) {
        return firstNonEmptyPage.content;
    }
    return "";
}

function getFirstNonEmptyPageImage(story: Story) {
    const firstNonEmptyPage = story.pages.find(page => !!page.image_url);
    if (firstNonEmptyPage) {
        return firstNonEmptyPage.image_url;
    }
    return "";
}



type Props = {
    story: Story
}

export default function StoryRow(props: Props) {
    const { story } = props
    const cardMediaRef = useRef<HTMLDivElement>(null);
    const isSmallerScreen = useMediaQuery('(max-width: 800px)');
    const [anchorEl, setAnchorEl] = useState(null);
    const [cardContentHeight, setCardContentHeight] = useState(115);

    useEffect(() => {
        function updateCardContentHeight() {
            if (cardMediaRef.current) {
                setCardContentHeight(cardMediaRef.current.offsetHeight);
            }
        }
        updateCardContentHeight();
        window.addEventListener("resize", updateCardContentHeight);
        window.dispatchEvent(new Event('resize'));
    }, []);

    return (
        <Card
            key={story.slug}
            style={{
                width: "100%",
                textAlign: "left",
                marginTop: "0.5em",
                paddingBottom: isSmallerScreen ? "1em" : "0.75em",
            }}
        >
            <Grid container>
                <CardHeader
                    disableTypography={true}
                    avatar={
                        <Link
                            to={`/${story.creator.username}`}
                            component={TransitionLink}
                        >
                            <Avatar
                                src={story.creator.avatar_image?.thumbnail || "tuzi.svg"}
                            />
                        </Link>
                    }
                    title={
                        <Typography
                            style={{
                                fontSize: isSmallerScreen ? "103%" : "107%",
                            }}
                        >
                            <Link
                                component={TransitionLink}
                                to={`/storytime/edit/${story.creator.username}/${story.slug}`}
                            >
                                {story.title}
                            </Link>
                        </Typography>
                    }
                    subheader={
                        <Stack direction="column">
                            <Typography
                                // variant="body2"
                                variant="caption"
                                color="textSecondary"
                                align="left"
                                style={{
                                    fontSize: isSmallerScreen ? "95%" : "100%",
                                }}
                            >
                                by <Link
                                    to={`/${story.creator.username}`}
                                    color="secondary"
                                    component={TransitionLink}
                                >
                                    {story.creator.username}
                                </Link>
                            </Typography>
                            <Typography
                                variant="caption"
                            >
                                {`${moment(story.created_at).fromNow()}`}, {`${moment(story.updated_at).fromNow()}`}
                            </Typography>
                        </Stack>
                    }
                />
                <Grid item xs={9}>
                    <CardContent
                        style={{
                            maxHeight: cardContentHeight,
                            height: cardContentHeight,
                            // marginLeft: "1em",
                            padding: "0 1em",
                            // padding: 0,
                            wordBreak: "break-word",
                        }}
                    >
                        <Stack
                            direction="row"
                            // it's crazy but this is needed for the
                            // lineClamp for some reason :/
                            alignItems="center"
                            // alignItems={"top"}
                            style={{
                                height: "100%",
                                marginTop: "-0.1em"
                            }}
                        >
                            <Typography
                                sx={{
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    display: "-webkit-box",
                                    // suuuuuckkkkkkkkzzzzzzz
                                    // https://css-tricks.com/almanac/properties/l/line-clamp/
                                    WebkitLineClamp: isSmallerScreen ? "3" : "5",
                                    WebkitBoxOrient: "vertical",
                                    fontSize: isSmallerScreen ? "95%" : "100%",
                                    lineHeight: "120%",
                                }}
                            >
                                {getFirstNonEmptyPageContent(story) || story.title}
                            </Typography>
                        </Stack>
                    </CardContent>
                </Grid>

                <Grid item xs={3}>
                    <CardMedia
                        ref={cardMediaRef}
                        style={{
                            height: 0,
                            paddingTop: '56.25%',  // 16:9
                            marginRight: "0.5em",
                            opacity: getFirstNonEmptyPageImage(story) ? 1 : 0.25,
                        }}
                        image={getFirstNonEmptyPageImage(story) || "/docs/img/tuzi.svg"}
                        title={story.title}
                    />
                </Grid>
            </Grid>
        </Card>
    )
}
