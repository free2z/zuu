

import { Share } from "@mui/icons-material";
import { IconButton, Tooltip } from "@mui/material";
import { RWebShare } from "react-web-share";


type ShareButtonProps = {
    conversationId: string
    title: string
    // creator:
}

export default function ShareConversation(props: ShareButtonProps) {
    // const location = useLocation()
    return (
        <RWebShare
            data={{
                // must match the app routes
                // url: `https://free2z.com/ai/conversation/${props.conversationId}/`,
                // TODO: actually, let's use the window location for the domain
                url: `https://free2z.com/ai/conversation/${props.conversationId}`,
                title: props.title,
                // text: `Check out "${props.title}" by ${props.creator.username} on free2z!`,
                text: `Converse: ${props.title} on free2z!`,
            }}
            onClick={() => console.log("shared successfully!")}
        >
            <Tooltip title="Share" placement="left">
                <IconButton>
                    <Share
                        color="info"
                        fontSize="large"
                    />
                </IconButton>
            </Tooltip>
        </RWebShare >
    );
};
