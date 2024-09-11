import {
    Grid, Avatar, Typography, Stack, useTheme, useMediaQuery,
    Box, IconButton, SwipeableDrawer, List, ListItem, ListItemButton,
    ListItemIcon, ListItemText,
} from "@mui/material";
import { Verified, Share, MoreVert } from "@mui/icons-material";


import { PublicCreator } from "../../CreatorDetail";
import { ProfileBody } from "./ProfileLayout";
import JoinLivestream from "../JoinLivesteam";
import ShareCreator, { CenterBadge } from "../ShareCreator";
import { useGlobalState } from "../../state/global";
import { useState } from "react";
import CreatorSupport from "./CreatorSupport";

const SwipeableDrawerList = ({ creator, isVerified, onClose }: { creator: any, isVerified: boolean, onClose: () => void }) => {
    const icons = {
        share: (
            <CenterBadge
                badgeContent={
                    isVerified && (
                        <div
                            style={{
                                fontSize: "13",
                            }}
                        >
                            <Verified
                                fontSize="inherit"
                                color="warning"
                            />
                        </div>
                    )
                }
            >
                <Share color="primary" />
            </CenterBadge>
        )
    };

    return (
        <Box
            component="div"
            role="presentation"
            onKeyDown={() => onClose()}
        >
            <List>
                {[{ id: 'share', label: 'Share', icon: icons.share }].map(({ id, label, icon }) => (
                    <ListItem key={id} disablePadding>
                        <ShareCreator {...creator}>
                            <ListItemButton>
                                <ListItemIcon>
                                    {icon}
                                </ListItemIcon>
                                <ListItemText primary={label} />
                            </ListItemButton>
                        </ShareCreator>
                    </ListItem>
                ))}
            </List>
        </Box>
    )
}

export default function HeroBanner(props: PublicCreator) {
    const theme = useTheme()
    // const isSmallerScreen = useMediaQuery('(max-width: 900px)');
    const [isMoreDropdownOpen, setIsMoreDropdownOpen] = useState(false);
    const [currentUser, _scu] = useGlobalState("creator")
    const isXS = useMediaQuery(theme.breakpoints.down('sm'));
    const isXXS = useMediaQuery("(max-width: 360px)");
    const isDarkMode = theme.palette.mode === "dark";
    const is_subbed = currentUser.stars.indexOf(props.username) !== -1
    const isProfile = (
        (typeof window.location !== "undefined" ? window.location : {}).pathname === "/profile"
    )

    return (
        <Grid container item xs={12}>
            <Grid item xs={12}
                sx={{
                    position: "relative",
                    // just uploaded is just a FileMetadata ...
                    backgroundImage:
                        `url(${props.banner_image?.thumbnail || "/tuzi.svg"})`,
                    // backgroundColor: "#9d28b009",
                    backgroundPosition: "center",
                    backgroundRepeat: "no-repeat",
                    backgroundSize: "cover",
                    // backgroundSize: "contain",
                    // backgroundSize: isXS ? "contain" : "cover",
                    // height: isXS ? "110px" : "213px",
                    height: {
                        xs: "115px",
                        sm: "180px",
                        md: "227px",
                    },
                    // marginTop: {
                    //     xs: "-20px",
                    //     sm: "0",
                    // },
                    opacity: props.banner_image?.url ? "1" : "0.2",
                }}
            >
                {/* <Box component="div" sx={{ position: "absolute", right: "16px", top: "16px" }}>
                    <SwipeableDrawer
                        anchor="bottom"
                        open={isMoreDropdownOpen}
                        onOpen={() => { }}
                        onClose={() => { setIsMoreDropdownOpen(false) }}
                    >
                        <SwipeableDrawerList creator={props} isVerified={props.is_verified} onClose={() => { setIsMoreDropdownOpen(false) }} />
                    </SwipeableDrawer>
                    <IconButton onClick={() => { setIsMoreDropdownOpen(true) }} aria-label="more-vert">
                        <MoreVert />
                    </IconButton>
                </Box> */}
            </Grid>
            <ProfileBody>
                {/* Avatar */}
                <Stack direction="row" justifyContent="space-between">
                    <Stack direction={["column", "row"]} pt={[0, "16px"]} flex={1}>
                        <Stack direction="column">
                            <Avatar
                                alt={props.username}
                                src={props.avatar_image?.thumbnail}
                                sx={{
                                    width: isXS ? 80 : 96,
                                    height: isXS ? 80 : 96,
                                    marginTop: "-48px",
                                    outline: isDarkMode ? "4px solid #121212" : "4px solid white",
                                    marginRight: "24px",
                                    position: "absolute",
                                }}
                            />
                            <Stack direction="row" justifyContent="space-between" alignItems="center" position="relative">
                                <Box component="div" flex={1} width="100%" />
                                {/* <CreatorDonate creator={props} /> */}
                                {/* <CreatorDonate isButton creator={props} /> */}
                                {(isXS) ?
                                    <Box component="div" sx={{ height: "40px" }}>
                                        <Stack direction="row" position="absolute" right="-16px" top={0}>
                                            <Stack sx={{ justifyContent: "center", width: "32px", mt: "-4px", mr: "8px" }}>
                                                <JoinLivestream {...props} />
                                            </Stack>
                                            <SwipeableDrawer
                                                anchor="bottom"
                                                open={isMoreDropdownOpen}
                                                onOpen={() => { }}
                                                onClose={() => { setIsMoreDropdownOpen(false) }}
                                            >
                                                <SwipeableDrawerList creator={props} isVerified={props.is_verified} onClose={() => { setIsMoreDropdownOpen(false) }} />
                                            </SwipeableDrawer>
                                            <IconButton onClick={() => { setIsMoreDropdownOpen(true) }} aria-label="more-vert" sx={{ pl: "0px" }}>
                                                <MoreVert />
                                            </IconButton>
                                        </Stack>
                                    </Box> : <Box component="div" sx={{ width: isXS ? 80 : 96, marginRight: '16px' }} />
                                }
                            </Stack>
                        </Stack>
                        {/* Name */}
                        <Grid item xs={12}>
                            <Stack
                                direction="column"
                                justifyContent="center"
                                textAlign="left"
                            >
                                <Stack direction="row" mt="-4px">
                                    <Typography
                                        sx={{
                                            mt: '0px',
                                            mb: '4px',
                                            // makes it smaller though
                                            lineHeight: "135%",
                                            lineBreak: "anywhere",
                                        }}
                                        variant="h6"
                                    >
                                        {props.full_name || props.username}
                                        {props.is_verified && (
                                            <Verified
                                                fontSize="inherit"
                                                color="warning"
                                                sx={{ marginLeft: "8px", position: "relative", top: "4px" }}
                                            />
                                        )}
                                    </Typography>
                                </Stack>
                                <Stack direction="row">
                                    <Typography
                                        variant="caption"
                                        color="textSecondary"
                                        style={{
                                            marginTop: "0px",
                                            marginBottom: "0.2em",
                                        }}
                                    >@{props.username}</Typography>
                                </Stack>
                            </Stack>
                        </Grid>
                        {!isXS && !isProfile &&
                            <>
                                <Box component="div" flex={1} />
                                <Stack direction="row" sx={{ gap: "8px", height: "48px", py: isXS ? "8px" : 0 }}>
                                    {!isXS && (
                                        <>
                                            <Stack sx={{ justifyContent: "center" }}>
                                                <JoinLivestream largeIcon {...props} />
                                            </Stack>
                                            <CreatorSupport initialPanel="panel-donate" isButton creator={props} {...props} />
                                            {
                                                props.member_price && (is_subbed ?
                                                    // <YouAreSubscribed isButton {...props} />
                                                    <CreatorSupport initialPanel="panel-subscribe" isButton creator={props} {...props} />
                                                    :
                                                    <CreatorSupport initialPanel="panel-subscribe" isButton creator={props} {...props} />
                                                )
                                            }
                                            <SwipeableDrawer
                                                anchor="bottom"
                                                open={isMoreDropdownOpen}
                                                onOpen={() => { }}
                                                onClose={() => { setIsMoreDropdownOpen(false) }}
                                            >
                                                <SwipeableDrawerList creator={props} isVerified={props.is_verified} onClose={() => { setIsMoreDropdownOpen(false) }} />
                                            </SwipeableDrawer>
                                            <IconButton onClick={() => { setIsMoreDropdownOpen(true) }} aria-label="more-vert">
                                                <MoreVert />
                                            </IconButton>
                                        </>
                                    )}
                                </Stack>
                            </>
                        }
                    </Stack>
                </Stack>
                {isXS && !isProfile && (
                    <Stack direction={isXXS ? "column" : "row"} sx={{ gap: "8px", py: "8px" }}>
                        <CreatorSupport initialPanel="panel-donate" isButton creator={props} {...props} />
                        {
                            is_subbed ?
                                // <YouAreSubscribed isButton {...props} />
                                <CreatorSupport initialPanel="panel-subscribe" isButton creator={props} {...props} />
                                :
                                <CreatorSupport initialPanel="panel-subscribe" isButton creator={props} {...props} />
                        }
                    </Stack>
                )}
                {/* Actions */}
                {/* <Grid item xs={12} md={12}
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                >
                    <CreatorInteract {...props} />
                </Grid> */}
            </ProfileBody>
        </Grid >
    )
}
