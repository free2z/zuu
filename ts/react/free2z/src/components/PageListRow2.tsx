import { Edit, MoreVert } from "@mui/icons-material";
import {
    Grid, CardMedia, Typography, Link, Stack, Card, CardContent,
    IconButton, CardHeader, Avatar, useMediaQuery, ListItem,
    Popover, Divider, Tooltip, Box,
} from "@mui/material";
import moment from "moment";
import { useEffect, useRef, useState } from "react";
import CreatorDonate from "./CreatorDonate";
import { PageInterface } from "./PageRenderer";
import UpDownPage from "./UpDownPage";
import { useGlobalState } from "../state/global";
import TransitionLink from "./TransitionLink";
import { useTransitionNavigate } from "../hooks/useTransitionNavigate";
import CreatorSupport from "./profile/CreatorSupport";


export interface PageListRowProps extends PageInterface {
    mine: boolean
}


export default function PageListRow(page: PageListRowProps) {
    const cardMediaRef = useRef<HTMLDivElement>(null);
    const [anchorEl, setAnchorEl] = useState(null);
    const [cardContentHeight, setCardContentHeight] = useState(115);
    const isSmallerScreen = useMediaQuery('(max-width: 800px)');
    const [user, setUser] = useGlobalState("creator")
    const navigate = useTransitionNavigate()

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

    const handleClick = (event: any) => {
        setAnchorEl(event.currentTarget);
    };

    const handleClose = () => {
        setAnchorEl(null);
    };

    if (!page.creator) {
        return null
    }

    const isSubbed = user.stars.indexOf(page.creator.username) !== -1

    return (
        <Card
            sx={{
                // display: 'flex', height: '100%',
                marginTop: "0.5em",
                textAlign: "left",
                // height: "240px",
                fontSize: isSmallerScreen ? "88%" : "100%",
                width: "100%",
                borderRadius: ['0px', '4px'],
                paddingBottom: isSmallerScreen ? "1em" : "0.75em",
                // textOverflow: "ellipsis",
            }}
            elevation={2}
        >
            <Grid container>
                <Grid item xs={12}>
                    <CardHeader
                        disableTypography={true}
                        avatar={
                            <Link
                                to={`/${page.creator.username}`}
                                component={TransitionLink}
                            >
                                <Avatar
                                    // Kinda small
                                    // sx={{
                                    //     // width: "10%",
                                    //     // height: "10%",
                                    // }}
                                    src={page.creator.avatar_image?.thumbnail || "tuzi.svg"}
                                />
                            </Link>
                        }
                        title={
                            <Typography
                                // alignItems="center"
                                // justifyContent="center"
                                style={{
                                    // This actually overrides to smaller
                                    fontSize: isSmallerScreen ? "103%" : "107%",
                                    // lol
                                    // lineClamp: 2,
                                    // WebkitLineClamp: "2",
                                    // WebkitBoxOrient: "vertical",
                                }}
                            >
                                <Link
                                    // style={{
                                    //     fontSize: isSmallerScreen ? "92%" : "100%",
                                    //     // lineClamp: 2,
                                    //     WebkitLineClamp: "2",
                                    //     WebkitBoxOrient: "vertical",
                                    // }}
                                    component={TransitionLink}
                                    to={page.mine ? `/edit/${page.vanity || page.free2zaddr}` : page.get_url}
                                >
                                    {page.title}
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
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        maxWidth: "205px",
                                    }}

                                >
                                    by <Link
                                        to={`/${page.creator.username}`}
                                        color="secondary"
                                        component={TransitionLink}
                                    >
                                        {page.creator.username}
                                    </Link>
                                </Typography>
                                <Typography
                                    variant="caption"
                                >
                                    {`${moment(page.created_at).fromNow()}`}, {`${moment(page.updated_at).fromNow()}`}
                                </Typography>
                            </Stack>
                        }
                        action={
                            <>
                                <Stack
                                    direction="row"
                                    alignItems="center"
                                    spacing={2}
                                >
                                    {/* TODO: would be cool but needs refresh when vote */}
                                    {/* <PageScore f2z_score={page.f2z_score} /> */}
                                    <IconButton
                                        onClick={handleClick}
                                        size="medium"
                                    >
                                        <MoreVert
                                            fontSize="medium"
                                        />
                                    </IconButton>
                                </Stack>
                                <Popover
                                    // id="simple-menu"
                                    anchorEl={anchorEl}
                                    keepMounted
                                    open={Boolean(anchorEl)}
                                    onClose={handleClose}
                                    style={{
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                    }}
                                >
                                    <ListItem
                                        style={{
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                        }}
                                    >
                                        <UpDownPage page={page} noShow={true} />
                                    </ListItem>
                                    <Divider />
                                    <ListItem
                                        style={{
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                        }}
                                    >
                                        <CreatorDonate
                                            creator={page.creator}
                                            addr={page.p2paddr}
                                        />
                                    </ListItem>
                                    {/* Can Sub */}
                                    {user.username !== page.creator.username && page.creator.member_price && !isSubbed &&
                                        <>
                                            <Divider />
                                            <ListItem
                                                style={{
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                }}
                                            >
                                                {/* <CreatorSubscribe
                                                    {...page.creator}
                                                /> */}
                                                <CreatorSupport isDialog initialPanel="panel-subscribe" isButton creator={page.creator} />
                                            </ListItem>
                                        </>
                                    }
                                    {/* Already subbed */}
                                    {user.username !== page.creator.username && page.creator.member_price && isSubbed &&
                                        <>
                                            <Divider />
                                            <ListItem
                                                style={{
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                }}
                                            >
                                                {/* <YouAreSubscribed {...page.creator} placement="left" /> */}
                                                <CreatorSupport initialPanel="panel-subscribe" isButton creator={page.creator} />
                                            </ListItem>
                                        </>
                                    }
                                    {user.username === page.creator.username &&
                                        <>
                                            <Divider />
                                            <ListItem
                                                style={{
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                }}
                                            >
                                                <Tooltip placement="left" title="Edit Page">
                                                    <IconButton
                                                        onClick={() => {
                                                            navigate(`/edit/${page.vanity || page.free2zaddr}`)
                                                        }}
                                                    >
                                                        <Edit />
                                                    </IconButton>
                                                </Tooltip>
                                            </ListItem>
                                        </>
                                    }
                                </Popover>
                            </>
                        }
                    />
                </Grid>


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
                                {page.is_subscriber_only &&
                                    <Box
                                        component="span"
                                        sx={{
                                            color: 'secondary.main',
                                            paddingRight: "0.33em",
                                        }}
                                    >
                                        Subscribers only
                                    </Box>
                                }
                                {page.content}
                            </Typography>
                        </Stack>
                    </CardContent>
                </Grid>

                <Grid item xs={3}>
                    {/* <Suspense fallback={
                        <CardMedia
                            style={{
                                width: 80,
                                height: 45,
                                margin: "0.75em",
                                opacity: 0.1,
                            }}
                        />
                    }> */}
                    <CardMedia
                        ref={cardMediaRef}
                        style={{
                            height: 0,
                            paddingTop: '56.25%',  // 16:9
                            marginRight: "0.5em",
                            opacity: page.featured_image ? 1 : 0.25,
                        }}
                        image={page.featured_image?.thumbnail || "/docs/img/tuzi.svg"}
                        title={page.title}
                    />
                    {/* </Suspense> */}
                </Grid>
                {/* TODO: tags woiuld be pretty cool on listing
                but too much space on mobile
                */}
                {/* <Grid item xs={12}>
                    <PageTags page={page} />
                </Grid> */}
            </Grid>
        </Card >
    );
};
