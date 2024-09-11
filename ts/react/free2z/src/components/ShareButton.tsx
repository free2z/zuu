import { Verified, Share } from "@mui/icons-material";
import { IconButton, Tooltip } from "@mui/material";
import { RWebShare } from "react-web-share";
import { SBadgeNB } from "./PageMetaFund";
import { PageInterface } from "./PageRenderer";


export default function ShareButton(props: PageInterface) {
    return (
        <RWebShare
            data={{
                url: window.location.href,
                title: props.title,
                text: `Check out "${props.title}" by ${props.creator.username} on free2z!`,
            }}
            onClick={() => console.log("shared successfully!")}
        >
            <Tooltip title="Share" placement="left">
                <SBadgeNB
                    badgeContent={
                        props.is_verified && (
                            <Verified
                                fontSize="small"
                                color="primary"
                            />
                        )
                    }
                >
                    <Share
                        color="info"
                        fontSize="large"
                    />
                </SBadgeNB>
            </Tooltip>
        </RWebShare>
    );
};
