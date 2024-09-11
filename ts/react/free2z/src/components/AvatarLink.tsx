import { Stack, Avatar, Typography, Link } from "@mui/material"
import TransitionLink from "./TransitionLink";
import { FeaturedImage } from "./PageRenderer";


type AvatarLinkProps = {
    username: string,
    avatar_image?: FeaturedImage | null,
}

export default function AvatarLink(props: AvatarLinkProps) {

    return (
        <Stack direction="column"
            justifyContent="center"
            alignItems="center"
            textAlign="center"
        >
            <Link
                to={`/${props.username}`}
                component={TransitionLink}
            >
                <Avatar
                    alt={props.username}
                    src={props.avatar_image?.thumbnail || "/tuzi.png"}
                    sx={{
                        width: 36,
                        height: 36,
                        margin: "0 auto 0 auto",
                    }}
                />
                <Typography variant="caption">{props.username}</Typography>
            </Link>
        </Stack>
    )
}
