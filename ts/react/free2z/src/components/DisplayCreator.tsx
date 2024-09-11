import { useState } from "react"
import { Chip, Divider, Grid, Paper, Stack, Typography, styled, useTheme } from "@mui/material"

import XIcon from '@mui/icons-material/X'
import InstagramIcon from '@mui/icons-material/Instagram'
import YouTubeIcon from '@mui/icons-material/YouTube';
import FacebookIcon from '@mui/icons-material/Facebook';
import LinkedInIcon from '@mui/icons-material/LinkedIn';
import RedditIcon from '@mui/icons-material/Reddit';
import LanguageIcon from '@mui/icons-material/Language';

import { PublicCreator } from "../CreatorDetail"
import HeroBanner from "./profile/HeroBanner"
import MathMarkdown from "./MathMarkdown"
import Find from "./Find"
import { Box } from "@mui/system"
import { ProfileBody } from "./profile/ProfileLayout"
import CreatorDonate from "./CreatorDonate"
import { Link } from "react-router-dom";

const SocialRow = styled(Paper)(({ theme }) => ({
    backgroundColor: theme.palette.mode === 'dark' ? '#121212' : '#121212',
    ...theme.typography.body2,
    padding: theme.spacing(1),
    textAlign: 'center',
    color: theme.palette.text.secondary,
}));

const socials = {
    "twitter": {
        prefix: "https://twitter.com/",
        name: "X",
        icon: XIcon,
    },
    "instagram": {
        prefix: "https://instagram.com/",
        name: "Instagram",
        icon: InstagramIcon,
    },
    "youtube": {
        prefix: "https://youtube.com/",
        name: "YouTube",
        icon: YouTubeIcon,
    },
    "facebook": {
        name: "Facebook",
        icon: FacebookIcon,
    },
    "linkedin": {
        name: "LinkedIn",
        icon: LinkedInIcon,
    },
    "reddit": {
        name: "Reddit",
        icon: RedditIcon,
    },
    "website": {
        name: "Website",
        icon: LanguageIcon,
    },
}


export default function DisplayCreator(props: PublicCreator) {
    const [metadata, setMetadata] = useState<{ socials?: any }>({});
    const theme = useTheme()
    const isDarkMode = theme.palette.mode === "dark"
    const onLoadFrontmatter = (newMetadata: any) => {
        if (newMetadata.socials) {
            setMetadata({ socials: newMetadata.socials });
        }
    }

    return (
        <Box
            component="div"
            style={{
                marginTop: '3em',
                marginBottom: "3em",
            }}
        >
            <HeroBanner {...props} />
            {metadata.socials && (
                <ProfileBody>
                    <Stack gap="16px" py="32px">
                        {Object.keys(metadata.socials).map((id) => {
                            const Icon = (socials as any)[id]?.icon
                            const prefix = (socials as any)[id]?.prefix

                            if (!metadata.socials[id]) { return null }
                            return (
                                <Link
                                    to={prefix
                                        ? `${prefix}${metadata.socials[id]}`
                                        : id === "website"
                                            ? `https://${metadata.socials[id]}`
                                            : ""
                                    }
                                    style={{ textDecoration: "none" }}
                                >
                                    <SocialRow key={id} sx={{ display: "flex", position: "relative", flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "secondary" }}>
                                        {Icon && <Icon sx={{ position: "absolute", left: "16px", color: isDarkMode ? undefined : "white" }} />}
                                        <Typography color="white">
                                            {!Icon ? `${(socials as any)[id].name}` : undefined}
                                            {prefix ? `@${metadata.socials[id]}` : metadata.socials[id]}
                                        </Typography>
                                    </SocialRow>
                                </Link>
                            )
                        })}
                    </Stack>
                </ProfileBody>
            )}
            <ProfileBody>
                <MathMarkdown content={props.description} onLoadFrontmatter={onLoadFrontmatter} />
            </ProfileBody>
            {props.zpages > 0 &&
                <>
                    <Grid item xs={12}
                        style={{ margin: "2em 0" }}
                    >
                        <Divider>
                            <Chip label="zPages" color="primary" variant="outlined" />
                        </Divider>
                    </Grid>


                    <ProfileBody sx={{ px: "0px" }}>
                        <Find mine={false} username={props.username} />
                    </ProfileBody>
                </>
            }
        </Box>
    )
}
